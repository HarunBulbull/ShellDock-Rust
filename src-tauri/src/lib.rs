use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::Session;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State};
use zeroize::Zeroizing;
mod drag_out;
mod files;
mod sftp;

type Result<T> = std::result::Result<T, String>;
pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth: String,
    private_key: String,
    group: String,
    notes: String,
    favorite: bool,
}
impl Connection {
    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.host.trim().is_empty()
            || self.username.trim().is_empty()
            || self.port == 0
        {
            return Err("Name, host, username and a valid port are required.".into());
        }
        if !["password", "privateKey", "agent"].contains(&self.auth.as_str()) {
            return Err("Unsupported authentication method.".into());
        }
        if self.auth == "privateKey" && self.private_key.is_empty() {
            return Err("Select a private key.".into());
        }
        Ok(())
    }
    fn endpoint(&self) -> String {
        format!("[{}]:{}", self.host, self.port)
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    connections: Vec<Connection>,
    hosts: HashMap<String, String>,
}
pub struct Context {
    connection: Connection,
    secret: Zeroizing<String>,
    fingerprint: String,
}
pub enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}
pub struct Live {
    input: mpsc::Sender<Input>,
    context: Arc<Context>,
    sftp: Arc<Mutex<Option<sftp::PooledSftp>>>,
}
struct PendingHandshake {
    session: Session,
    fingerprint: String,
    created: Instant,
}
#[derive(Default)]
pub struct Backend {
    store: Mutex<Store>,
    sessions: Arc<Mutex<HashMap<String, Live>>>,
    path: Mutex<PathBuf>,
    transfers: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    handshakes: Mutex<HashMap<String, PendingHandshake>>,
    external_edits: Arc<Mutex<HashMap<String, sftp::ExternalEditHandle>>>,
}
fn persist(state: &Backend, store: &Store) -> Result<()> {
    let path = state.path.lock().map_err(err)?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec_pretty(store).map_err(err)?).map_err(err)?;
    fs::rename(temp, &*path).map_err(err)
}
fn handshake(c: &Connection) -> Result<(Session, String)> {
    c.validate()?;
    let addresses = (c.host.as_str(), c.port).to_socket_addrs().map_err(err)?;
    let mut tcp = None;
    for address in addresses {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            tcp = Some(stream);
            break;
        }
    }
    let tcp = tcp.ok_or("Unable to reach the SSH server (10 second timeout per address).")?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(err)?;
    tcp.set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(err)?;
    let mut session = Session::new().map_err(err)?;
    session.set_tcp_stream(tcp);
    session.set_timeout(15_000);
    session.handshake().map_err(err)?;
    let (key, _) = session
        .host_key()
        .ok_or("Server did not provide a host key.")?;
    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)));
    Ok((session, fingerprint))
}
fn authenticate_session(session: Session, fingerprint: &str, context: &Context) -> Result<Session> {
    if fingerprint != context.fingerprint {
        return Err("Host key changed. Disconnect and review the server fingerprint.".into());
    }
    let c = &context.connection;
    match c.auth.as_str() {
        "password" => session
            .userauth_password(&c.username, &context.secret)
            .map_err(err)?,
        "privateKey" => session
            .userauth_pubkey_file(
                &c.username,
                None,
                Path::new(&c.private_key),
                if context.secret.is_empty() {
                    None
                } else {
                    Some(&context.secret)
                },
            )
            .map_err(err)?,
        "agent" => session.userauth_agent(&c.username).map_err(err)?,
        _ => return Err("Unsupported authentication.".into()),
    }
    if !session.authenticated() {
        return Err("Authentication failed.".into());
    }
    session.set_keepalive(true, 20);
    Ok(session)
}
pub(crate) fn authenticate(context: &Context) -> Result<Session> {
    let (session, fingerprint) = handshake(&context.connection)?;
    authenticate_session(session, &fingerprint, context)
}
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}
pub(crate) fn context(state: &Backend, id: &str) -> Result<Arc<Context>> {
    state
        .sessions
        .lock()
        .map_err(err)?
        .get(id)
        .map(|s| s.context.clone())
        .ok_or("Session is closed.".into())
}
#[tauri::command]
fn list_connections(state: State<Backend>) -> Result<Vec<Connection>> {
    Ok(state.store.lock().map_err(err)?.connections.clone())
}
#[tauri::command]
fn save_connection(state: State<Backend>, connection: Connection) -> Result<()> {
    connection.validate()?;
    let mut store = state.store.lock().map_err(err)?;
    let previous = store.connections.clone();
    store.connections.retain(|c| c.id != connection.id);
    store.connections.push(connection);
    if let Err(e) = persist(&state, &store) {
        store.connections = previous;
        return Err(e);
    }
    Ok(())
}
#[tauri::command]
fn delete_connection(state: State<Backend>, id: String) -> Result<()> {
    let mut store = state.store.lock().map_err(err)?;
    let previous = store.connections.clone();
    store.connections.retain(|c| c.id != id);
    if let Err(e) = persist(&state, &store) {
        store.connections = previous;
        return Err(e);
    }
    if let Ok(entry) = keyring::Entry::new("ShellDock", &id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbe {
    fingerprint: String,
    previous: Option<String>,
}
fn handshake_key(c: &Connection) -> String {
    format!("{}|{}", c.id, c.endpoint())
}

fn take_pending_handshake(state: &Backend, c: &Connection) -> Option<(Session, String)> {
    let key = handshake_key(c);
    let mut map = state.handshakes.lock().ok()?;
    map.retain(|_, item| item.created.elapsed() < Duration::from_secs(60));
    map.remove(&key)
        .map(|item| (item.session, item.fingerprint))
}

#[tauri::command]
async fn probe_host(state: State<'_, Backend>, connection: Connection) -> Result<HostProbe> {
    let previous = state
        .store
        .lock()
        .map_err(err)?
        .hosts
        .get(&connection.endpoint())
        .cloned();
    let key = handshake_key(&connection);
    let conn = connection.clone();
    let (session, fingerprint) = blocking(move || handshake(&conn)).await?;
    if let Ok(mut map) = state.handshakes.lock() {
        map.retain(|_, item| item.created.elapsed() < Duration::from_secs(60));
        map.insert(
            key,
            PendingHandshake {
                session,
                fingerprint: fingerprint.clone(),
                created: Instant::now(),
            },
        );
    }
    Ok(HostProbe {
        fingerprint,
        previous,
    })
}

#[tauri::command]
async fn list_saved_credentials(state: State<'_, Backend>) -> Result<Vec<String>> {
    let ids: Vec<String> = state
        .store
        .lock()
        .map_err(err)?
        .connections
        .iter()
        .map(|c| c.id.clone())
        .collect();
    blocking(move || {
        Ok(ids
            .into_iter()
            .filter(|id| {
                keyring::Entry::new("ShellDock", id)
                    .and_then(|e| e.get_password())
                    .map(|p| !p.is_empty())
                    .unwrap_or(false)
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn save_credential(id: String, secret: String) -> Result<()> {
    blocking(move || {
        let entry = keyring::Entry::new("ShellDock", &id).map_err(err)?;
        if secret.is_empty() {
            let _ = entry.delete_credential();
        } else {
            entry.set_password(&secret).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn delete_credential(id: String) -> Result<()> {
    blocking(move || {
        if let Ok(entry) = keyring::Entry::new("ShellDock", &id) {
            let _ = entry.delete_credential();
        }
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestConnectionResult {
    fingerprint: String,
    previous: Option<String>,
    trusted: bool,
    authenticated: bool,
    message: String,
}

#[tauri::command]
async fn test_connection(
    state: State<'_, Backend>,
    connection: Connection,
    secret: String,
) -> Result<TestConnectionResult> {
    connection.validate()?;
    let previous = state
        .store
        .lock()
        .map_err(err)?
        .hosts
        .get(&connection.endpoint())
        .cloned();
    blocking(move || {
        let (session, fingerprint) = handshake(&connection)?;
        let trusted = previous.as_deref() == Some(fingerprint.as_str());
        if !trusted {
            return Ok(TestConnectionResult {
                fingerprint,
                previous: previous.clone(),
                trusted: false,
                authenticated: false,
                message: if previous.is_some() {
                    "Host key changed from stored fingerprint.".into()
                } else {
                    "Reachable. Host key is not trusted yet; it will prompt on connect.".into()
                },
            });
        }
        let mut effective_secret = Zeroizing::new(secret);
        if effective_secret.is_empty() {
            if let Ok(entry) = keyring::Entry::new("ShellDock", &connection.id) {
                if let Ok(password) = entry.get_password() {
                    effective_secret = Zeroizing::new(password);
                }
            }
        }
        let ctx = Context {
            connection,
            secret: effective_secret,
            fingerprint: fingerprint.clone(),
        };
        authenticate_session(session, &fingerprint, &ctx)?;
        Ok(TestConnectionResult {
            fingerprint,
            previous,
            trusted: true,
            authenticated: true,
            message: "Connected and authenticated successfully.".into(),
        })
    })
    .await
}
#[tauri::command]
fn trust_host(state: State<Backend>, connection: Connection, fingerprint: String) -> Result<()> {
    if !fingerprint.starts_with("SHA256:") {
        return Err("Invalid fingerprint.".into());
    }
    let mut store = state.store.lock().map_err(err)?;
    let endpoint = connection.endpoint();
    let previous = store.hosts.insert(endpoint.clone(), fingerprint);
    if let Err(e) = persist(&state, &store) {
        match previous {
            Some(value) => {
                store.hosts.insert(endpoint, value);
            }
            None => {
                store.hosts.remove(&endpoint);
            }
        }
        return Err(e);
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
enum TerminalEvent {
    Output(Vec<u8>),
    Closed,
    Error(String),
}
#[tauri::command]
async fn connect(
    state: State<'_, Backend>,
    connection: Connection,
    secret: String,
    remember: bool,
    output: Channel<TerminalEvent>,
    cols: u32,
    rows: u32,
) -> Result<String> {
    connection.validate()?;
    let fingerprint = state
        .store
        .lock()
        .map_err(err)?
        .hosts
        .get(&connection.endpoint())
        .cloned()
        .ok_or("Review and trust the host key first.")?;
    let pending = take_pending_handshake(&state, &connection);
    let id = uuid::Uuid::new_v4().to_string();
    let live_id = id.clone();
    let sessions = state.sessions.clone();
    let external_edits = state.external_edits.clone();
    let ctx = Arc::new(Context {
        connection,
        secret: Zeroizing::new(secret),
        fingerprint,
    });
    let (tx, rx) = mpsc::channel();
    blocking(move || {
        let mut ctx = ctx;
        if ctx.secret.is_empty() {
            if let Ok(entry) = keyring::Entry::new("ShellDock", &ctx.connection.id) {
                if let Ok(password) = entry.get_password() {
                    Arc::get_mut(&mut ctx)
                        .ok_or("Internal credential error")?
                        .secret = Zeroizing::new(password);
                }
            }
        }
        let session = match pending {
            Some((sess, fp)) => authenticate_session(sess, &fp, &ctx)?,
            None => authenticate(&ctx)?,
        };
        if remember && !ctx.secret.is_empty() {
            keyring::Entry::new("ShellDock", &ctx.connection.id)
                .map_err(err)?
                .set_password(&ctx.secret)
                .map_err(err)?;
        }
        let mut channel = session.channel_session().map_err(err)?;
        channel
            .request_pty(
                "xterm-256color",
                None,
                Some((cols.clamp(2, 500), rows.clamp(2, 200), 0, 0)),
            )
            .map_err(err)?;
        channel.shell().map_err(err)?;
        session.set_blocking(false);
        sessions.lock().map_err(err)?.insert(
            live_id.clone(),
            Live {
                input: tx,
                context: ctx.clone(),
                sftp: Arc::new(Mutex::new(None)),
            },
        );
        thread::spawn(move || {
            let result = (|| -> Result<()> {
                let mut pending = Vec::new();
                let mut offset = 0;
                let mut buffer = [0u8; 16384];
                let mut keepalive = std::time::Instant::now();
                loop {
                    loop {
                        match rx.try_recv() {
                            Ok(Input::Data(bytes)) => pending.extend(bytes),
                            Ok(Input::Resize(cols, rows)) => {
                                let _ = channel.request_pty_size(
                                    cols.clamp(2, 500),
                                    rows.clamp(2, 200),
                                    None,
                                    None,
                                );
                            }
                            Ok(Input::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                                return Ok(())
                            }
                            Err(mpsc::TryRecvError::Empty) => break,
                        }
                    }
                    if offset < pending.len() {
                        match channel.write(&pending[offset..]) {
                            Ok(n) => offset += n,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                            Err(e) => return Err(err(e)),
                        }
                    }
                    if offset == pending.len() {
                        pending.clear();
                        offset = 0;
                    }
                    match channel.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            if output
                                .send(TerminalEvent::Output(buffer[..n].to_vec()))
                                .is_err()
                            {
                                return Ok(());
                            }
                        }
                        Ok(_) => {
                            if channel.eof() {
                                return Ok(());
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                        Err(e) => return Err(err(e)),
                    }
                    if keepalive.elapsed() >= Duration::from_secs(20) {
                        session.keepalive_send().map_err(err)?;
                        keepalive = std::time::Instant::now();
                    }
                    thread::sleep(Duration::from_millis(8));
                }
            })();
            if let Err(e) = result {
                let _ = output.send(TerminalEvent::Error(e));
            }
            if let Ok(mut live) = sessions.lock() {
                live.remove(&live_id);
            }
            cleanup_session_edits(&external_edits, &live_id);
            let _ = output.send(TerminalEvent::Closed);
        });
        Ok(id)
    })
    .await
}
#[tauri::command]
fn terminal_write(state: State<Backend>, id: String, data: String) -> Result<()> {
    state
        .sessions
        .lock()
        .map_err(err)?
        .get(&id)
        .ok_or("Session closed")?
        .input
        .send(Input::Data(data.into_bytes()))
        .map_err(err)
}
#[tauri::command]
fn terminal_resize(state: State<Backend>, id: String, cols: u32, rows: u32) -> Result<()> {
    state
        .sessions
        .lock()
        .map_err(err)?
        .get(&id)
        .ok_or("Session closed")?
        .input
        .send(Input::Resize(cols, rows))
        .map_err(err)
}
fn cleanup_session_edits(
    edits: &Mutex<HashMap<String, sftp::ExternalEditHandle>>,
    session_id: &str,
) {
    if let Ok(mut map) = edits.lock() {
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            if let Some(handle) = map.remove(&key) {
                handle
                    .stop
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = fs::remove_dir_all(&handle.temp_dir);
            }
        }
    }
}

fn sweep_stale_temp_dirs() {
    let temp = std::env::temp_dir();
    let Ok(entries) = fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("shelldock-drag-") || name.starts_with("shelldock-edit-")) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().unwrap_or_default() > Duration::from_secs(7200) {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

#[tauri::command]
fn disconnect(state: State<Backend>, id: String) -> Result<()> {
    if let Some(live) = state.sessions.lock().map_err(err)?.remove(&id) {
        let _ = live.input.send(Input::Close);
    }
    cleanup_session_edits(&state.external_edits, &id);
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub directory: bool,
    pub symlink: bool,
    pub modified: u64,
    pub permissions: Option<u32>,
}

pub fn run() {
    sweep_stale_temp_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::default())
        .setup(|app| {
            let folder = app.path().app_data_dir()?;
            fs::create_dir_all(&folder)?;
            let path = folder.join("workspace.json");
            let store = if path.exists() {
                serde_json::from_slice(&fs::read(&path)?)?
            } else {
                Store::default()
            };
            let state = app.state::<Backend>();
            *state.store.lock().unwrap() = store;
            *state.path.lock().unwrap() = path;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            probe_host,
            trust_host,
            list_saved_credentials,
            save_credential,
            delete_credential,
            test_connection,
            connect,
            terminal_write,
            terminal_resize,
            disconnect,
            sftp::list_remote,
            sftp::remote_home,
            sftp::remote_action,
            sftp::remote_delete_batch,
            sftp::read_remote,
            sftp::write_remote,
            sftp::open_remote_external,
            sftp::stop_remote_external,
            files::list_local,
            files::local_action,
            files::transfer_batch,
            files::cancel_transfer,
            drag_out::list_local_places,
            drag_out::open_local_default,
            drag_out::reveal_local,
            drag_out::start_external_drag
        ])
        .build(tauri::generate_context!())
        .expect("Unable to initialize ShellDock")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<Backend>();
                if let Ok(mut sessions) = state.sessions.lock() {
                    for (_, live) in sessions.drain() {
                        let _ = live.input.send(Input::Close);
                    }
                };
                if let Ok(mut edits) = state.external_edits.lock() {
                    for (_, handle) in edits.drain() {
                        handle
                            .stop
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        let _ = fs::remove_dir_all(&handle.temp_dir);
                    }
                };
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    struct Fixture(std::process::Child);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(windows)]
    #[test]
    fn windows_credential_roundtrip_and_deletion() {
        // A unique fixture identity never reads or modifies the user's saved credentials.
        let id = uuid::Uuid::new_v4().to_string();
        let entry = keyring::Entry::new("ShellDock.Tests", &id).unwrap();
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let cleanup = Cleanup(entry);
        cleanup.0.set_password("temporary-test-credential").unwrap();
        assert_eq!(
            cleanup.0.get_password().unwrap(),
            "temporary-test-credential"
        );
        cleanup.0.delete_credential().unwrap();
        assert!(matches!(
            cleanup.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
    #[test]
    fn live_ssh_and_sftp_roundtrip_rejects_changed_host_key() {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/test-server.cjs");
        let keys = tempfile::tempdir().unwrap();
        let private_key = keys.path().join("fixture-key.pem");
        let ed25519_key = keys.path().join("fixture-ed25519");
        let mut child = std::process::Command::new("node")
            .arg(script)
            .arg(&private_key)
            .arg(&ed25519_key)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("Node.js and npm ci are required for the fixture");
        let stdout = child.stdout.take().unwrap();
        let _fixture = Fixture(child);
        let mut port = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut port)
            .unwrap();
        let mut c = connection();
        c.host = "127.0.0.1".into();
        c.port = port.trim().parse().unwrap();
        c.username = "tester".into();
        c.auth = "password".into();
        let (_, fingerprint) = handshake(&c).unwrap();
        let mut ctx = Context {
            connection: c,
            secret: Zeroizing::new("fixture-password".into()),
            fingerprint,
        };
        let session = authenticate(&ctx).unwrap();
        assert_eq!(
            session.methods(ssh2::MethodType::HostKey),
            Some("ssh-ed25519")
        );
        let mut shell = session.channel_session().unwrap();
        shell
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .unwrap();
        shell.shell().unwrap();
        shell.request_pty_size(100, 30, None, None).unwrap();
        let mut bytes = [0u8; 256];
        let n = shell.read(&mut bytes).unwrap();
        assert!(String::from_utf8_lossy(&bytes[..n]).contains("fixture ready"));
        shell.write_all(b"exit\r\n").unwrap();
        let mut output = String::new();
        shell.read_to_string(&mut output).unwrap();
        assert!(output.contains("exit"));
        let sftp = session.sftp().unwrap();
        assert!(sftp
            .readdir(Path::new("/"))
            .unwrap()
            .iter()
            .any(|(path, _)| path.ends_with("hello.txt")));
        let payload = "UTF-8: merhaba, dünya 🦀".as_bytes();
        {
            let mut file = sftp
                .open_mode(
                    Path::new("/roundtrip.txt"),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                    0o644,
                    ssh2::OpenType::File,
                )
                .unwrap();
            file.write_all(payload).unwrap();
        }
        let mut downloaded = Vec::new();
        sftp.open(Path::new("/roundtrip.txt"))
            .unwrap()
            .read_to_end(&mut downloaded)
            .unwrap();
        assert_eq!(downloaded, payload);
        assert!(sftp
            .open_mode(
                Path::new("/roundtrip.txt"),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                0o644,
                ssh2::OpenType::File
            )
            .is_err());
        sftp.rename(
            Path::new("/roundtrip.txt"),
            Path::new("/renamed.txt"),
            Some(ssh2::RenameFlags::empty()),
        )
        .unwrap();
        sftp.unlink(Path::new("/renamed.txt")).unwrap();
        // Exercise the production batch engine with nested folders and multiple roots.
        let source_dir = tempfile::tempdir().unwrap();
        let folder = source_dir.path().join("project");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::create_dir(folder.join("empty")).unwrap();
        fs::write(folder.join("nested/data.txt"), b"batch payload").unwrap();
        let loose = source_dir.path().join("loose.txt");
        fs::write(&loose, b"loose").unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let request = files::BatchRequest {
            job_id: "test-batch".into(),
            sources: vec![
                folder.to_string_lossy().into(),
                loose.to_string_lossy().into(),
            ],
            destination: "/".into(),
            upload: true,
            policy: "skip".into(),
            verify: true,
        };
        let uploaded = files::run_batch(&ctx, &request, &cancel, |_| {}).unwrap();
        assert_eq!(uploaded.completed_files, 2);
        assert_eq!(uploaded.completed_bytes, 18);
        assert!(sftp.stat(Path::new("/project/empty")).unwrap().is_dir());
        let skipped = files::run_batch(&ctx, &request, &cancel, |_| {}).unwrap();
        assert_eq!(skipped.skipped_files, 2);
        assert_eq!(skipped.completed_files, 0);
        let destination = tempfile::tempdir().unwrap();
        let download = files::BatchRequest {
            job_id: "download".into(),
            sources: vec!["/project".into(), "/loose.txt".into()],
            destination: destination.path().to_string_lossy().into(),
            upload: false,
            policy: "skip".into(),
            verify: true,
        };
        let received = files::run_batch(&ctx, &download, &cancel, |_| {}).unwrap();
        assert_eq!(received.completed_files, 2);
        assert_eq!(
            fs::read(destination.path().join("project/nested/data.txt")).unwrap(),
            b"batch payload"
        );
        assert!(destination.path().join("project/empty").is_dir());
        fs::write(destination.path().join("loose.txt"), b"keep existing").unwrap();
        let again = files::run_batch(&ctx, &download, &cancel, |_| {}).unwrap();
        assert_eq!(again.skipped_files, 2);
        assert_eq!(
            fs::read(destination.path().join("loose.txt")).unwrap(),
            b"keep existing"
        );
        let mut replace_download = download.clone();
        replace_download.policy = "replace".into();
        assert_eq!(
            files::run_batch(&ctx, &replace_download, &cancel, |_| {})
                .unwrap()
                .completed_files,
            2
        );
        assert_eq!(
            fs::read(destination.path().join("loose.txt")).unwrap(),
            b"loose"
        );
        fs::write(&loose, b"replacement contents").unwrap();
        let mut replace_upload = request.clone();
        replace_upload.policy = "replace".into();
        assert_eq!(
            files::run_batch(&ctx, &replace_upload, &cancel, |_| {})
                .unwrap()
                .completed_files,
            2
        );
        let mut replaced = String::new();
        sftp.open(Path::new("/loose.txt"))
            .unwrap()
            .read_to_string(&mut replaced)
            .unwrap();
        assert_eq!(replaced, "replacement contents");
        let corrupt = source_dir.path().join("__corrupt_upload.txt");
        fs::write(&corrupt, b"expected bytes").unwrap();
        let corrupt_request = files::BatchRequest {
            job_id: "corrupt-server".into(),
            sources: vec![corrupt.to_string_lossy().into()],
            destination: "/".into(),
            upload: true,
            policy: "replace".into(),
            verify: true,
        };
        assert!(files::run_batch(&ctx, &corrupt_request, &cancel, |_| {})
            .unwrap_err()
            .contains("verification failed"));
        {
            let mut original = sftp.create(Path::new("/__reject_commit.txt")).unwrap();
            original.write_all(b"original must survive").unwrap();
            original.close().unwrap();
        }
        let rejected_file = source_dir.path().join("__reject_commit.txt");
        fs::write(&rejected_file, b"new contents").unwrap();
        let rejected = files::BatchRequest {
            job_id: "rollback".into(),
            sources: vec![rejected_file.to_string_lossy().into()],
            destination: "/".into(),
            upload: true,
            policy: "replace".into(),
            verify: true,
        };
        assert!(files::run_batch(&ctx, &rejected, &cancel, |_| {})
            .unwrap_err()
            .contains("original restored"));
        let mut original = String::new();
        sftp.open(Path::new("/__reject_commit.txt"))
            .unwrap()
            .read_to_string(&mut original)
            .unwrap();
        assert_eq!(original, "original must survive");
        assert!(!sftp
            .readdir(Path::new("/"))
            .unwrap()
            .iter()
            .any(|(p, _)| p.to_string_lossy().contains(".backup")
                || p.to_string_lossy().contains(".part")));
        let stop = std::sync::atomic::AtomicBool::new(false);
        assert!(files::run_batch(&ctx, &replace_upload, &stop, |p| {
            if p.current.ends_with("data.txt") {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .is_err());
        assert!(!sftp
            .readdir(Path::new("/project/nested"))
            .unwrap()
            .iter()
            .any(|(p, _)| p.to_string_lossy().contains(".part")));
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(files::run_batch(&ctx, &request, &cancel, |_| {})
            .unwrap_err()
            .contains("cancelled"));
        // Verify recursive deletion removes non-empty directories via SFTP RMDIR + UNLINK.
        assert!(sftp.rmdir(Path::new("/project")).is_err());
        sftp::delete_remote_entry(&sftp, "/project", 0).unwrap();
        assert!(sftp.stat(Path::new("/project")).is_err());
        assert!(sftp::delete_remote_entry(&sftp, "/", 0).is_err());
        // Verify remote YAML editor roundtrip, binary detection, and conflict protection.
        let yaml_res =
            sftp::write_remote_sftp(&sftp, "/app.yml", b"service:\n  port: 8080\n", None, false)
                .map_err(|e| e.to_string())
                .unwrap();
        let read_back = sftp::read_remote_sftp(&sftp, "/app.yml", None)
            .map_err(|e| e.to_string())
            .unwrap();
        assert_eq!(read_back.text, "service:\n  port: 8080\n");
        assert!(!read_back.binary);
        assert!(sftp::write_remote_sftp(
            &sftp,
            "/app.yml",
            b"updated",
            Some(yaml_res.mtime.unwrap_or(0) + 99),
            false,
        )
        .err()
        .unwrap()
        .to_string()
        .starts_with("CONFLICT:"));
        sftp::write_remote_sftp(&sftp, "/app.yml", b"service:\n  port: 9090\n", None, true)
            .map_err(|e| e.to_string())
            .unwrap();
        assert_eq!(
            sftp::read_remote_sftp(&sftp, "/app.yml", None)
                .map_err(|e| e.to_string())
                .unwrap()
                .text,
            "service:\n  port: 9090\n"
        );
        // Verify large trees (>2,000 items) and >2MB streamed files work in both
        // batch downloads and Windows external drag-and-drop.
        sftp.mkdir(Path::new("/minecraft"), 0o755).unwrap();
        sftp.mkdir(Path::new("/minecraft/plugins"), 0o755).unwrap();
        sftp.mkdir(Path::new("/minecraft/world"), 0o755).unwrap();
        sftp.mkdir(Path::new("/minecraft/world/empty"), 0o755)
            .unwrap();
        for dir_idx in 0..22 {
            let folder = format!("/minecraft/plugins/p{dir_idx}");
            sftp.mkdir(Path::new(&folder), 0o755).unwrap();
            for file_idx in 0..100 {
                let file_path = format!("{folder}/f{file_idx}.yml");
                let mut f = sftp
                    .open_mode(
                        Path::new(&file_path),
                        ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE,
                        0o644,
                        ssh2::OpenType::File,
                    )
                    .unwrap();
                f.write_all(b"ok").unwrap();
                f.close().unwrap();
            }
        }
        let big_payload = vec![0x5Au8; 2 * 1024 * 1024 + 131_072];
        {
            let mut f = sftp
                .open_mode(
                    Path::new("/minecraft/world/region.bin"),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE,
                    0o644,
                    ssh2::OpenType::File,
                )
                .unwrap();
            f.write_all(&big_payload).unwrap();
            f.close().unwrap();
        }
        let tree_entries = drag_out::collect_all_drag_entries(
            &sftp,
            &[drag_out::DragEntry {
                remote_path: "/minecraft".into(),
                relative_windows_path: "minecraft".into(),
                directory: true,
                size: 0,
            }],
            &std::sync::atomic::AtomicBool::new(false),
        )
        .unwrap();
        assert!(tree_entries.len() > 2_200);
        let large_batch_dest = tempfile::tempdir().unwrap();
        let large_download = files::BatchRequest {
            job_id: "large-tree".into(),
            sources: vec!["/minecraft".into()],
            destination: large_batch_dest.path().to_string_lossy().into(),
            upload: false,
            policy: "replace".into(),
            verify: false,
        };
        let large_res = files::run_batch(
            &ctx,
            &large_download,
            &std::sync::atomic::AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(large_res.completed_files, 2201);
        assert!(large_batch_dest
            .path()
            .join("minecraft/world/empty")
            .is_dir());
        assert_eq!(
            fs::read(large_batch_dest.path().join("minecraft/world/region.bin")).unwrap(),
            big_payload
        );
        #[cfg(windows)]
        {
            let drop_dest = tempfile::tempdir().unwrap();
            let drag_ctx = Arc::new(Context {
                connection: ctx.connection.clone(),
                secret: Zeroizing::new(ctx.secret.to_string()),
                fingerprint: ctx.fingerprint.clone(),
            });
            drag_out::test_mta_drop_to_dir(drag_ctx, "/minecraft", drop_dest.path()).unwrap();
            assert!(drop_dest.path().join("minecraft/world/empty").is_dir());
            assert_eq!(
                fs::read_to_string(drop_dest.path().join("minecraft/plugins/p21/f99.yml")).unwrap(),
                "ok"
            );
            assert_eq!(
                fs::read(drop_dest.path().join("minecraft/world/region.bin")).unwrap(),
                big_payload
            );
        }
        ctx.fingerprint = "SHA256:wrong-host-key".into();
        assert!(authenticate(&ctx)
            .err()
            .unwrap()
            .contains("Host key changed"));
        ctx.fingerprint = handshake(&ctx.connection).unwrap().1;
        ctx.secret = Zeroizing::new("incorrect-test-password".into());
        assert!(authenticate(&ctx).is_err());
        ctx.connection.auth = "privateKey".into();
        ctx.connection.private_key = private_key.to_string_lossy().into_owned();
        ctx.secret = Zeroizing::new("fixture-passphrase".into());
        assert!(authenticate(&ctx).unwrap().authenticated());
        ctx.secret = Zeroizing::new("incorrect-passphrase".into());
        assert!(authenticate(&ctx).is_err());
        ctx.connection.private_key = ed25519_key.to_string_lossy().into_owned();
        ctx.secret = Zeroizing::new(String::new());
        assert!(authenticate(&ctx).unwrap().authenticated());
    }
    fn connection() -> Connection {
        Connection {
            id: "test".into(),
            name: "Server".into(),
            host: "::1".into(),
            port: 22,
            username: "root".into(),
            auth: "agent".into(),
            private_key: String::new(),
            group: String::new(),
            notes: String::new(),
            favorite: false,
        }
    }
    #[test]
    fn validates_connections() {
        let mut c = connection();
        assert!(c.validate().is_ok());
        c.port = 0;
        assert!(c.validate().is_err());
        c.port = 22;
        c.auth = "shell".into();
        assert!(c.validate().is_err());
    }
    #[test]
    fn endpoints_include_port_and_support_ipv6() {
        assert_eq!(connection().endpoint(), "[::1]:22");
    }
    #[test]
    fn metadata_contains_no_credentials() {
        let value = serde_json::to_string(&connection()).unwrap();
        assert!(!value.contains("password"));
        assert!(!value.contains("secret"));
    }
    #[test]
    fn persists_connection_and_host_trust() {
        let dir = tempfile::tempdir().unwrap();
        let state = Backend::default();
        *state.path.lock().unwrap() = dir.path().join("workspace.json");
        let mut store = Store::default();
        store.connections.push(connection());
        store
            .hosts
            .insert(connection().endpoint(), "SHA256:test".into());
        persist(&state, &store).unwrap();
        persist(&state, &store).unwrap();
        let loaded: Store =
            serde_json::from_slice(&fs::read(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(loaded.connections.len(), 1);
        assert_eq!(loaded.hosts["[::1]:22"], "SHA256:test");
    }
}
