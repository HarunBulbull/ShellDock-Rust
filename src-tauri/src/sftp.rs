use crate::{authenticate, blocking, drag_out, err, files, Backend, Context, FileEntry, Result};
use serde::Serialize;
use ssh2::{FileStat, Session, Sftp};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, State};

const MAX_EDIT_BYTES: u64 = 2_000_000;
const PREVIEW_BYTES: u64 = 512_000;

pub struct PooledSftp {
    pub sftp: Sftp,
    pub _session: Session,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectory {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBatchResult {
    pub deleted: Vec<String>,
    pub failed: Vec<BatchFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextFile {
    pub path: String,
    pub text: String,
    pub mtime: Option<u64>,
    pub size: u64,
    pub permissions: Option<u32>,
    pub read_only: bool,
    pub read_only_reason: Option<String>,
    pub truncated: bool,
    pub preview_mode: Option<String>,
    pub lossy_utf8: bool,
    pub binary: bool,
    pub line_ending: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: Option<u64>,
    pub size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditEvent {
    pub edit_id: String,
    pub session_id: String,
    pub path: String,
    pub status: String,
    pub message: Option<String>,
}

pub struct ExternalEditHandle {
    pub session_id: String,
    pub stop: Arc<AtomicBool>,
    pub temp_dir: PathBuf,
}

pub(crate) enum SftpError {
    Ssh(ssh2::Error),
    Msg(String),
}

impl std::fmt::Display for SftpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ssh(e) => write!(f, "{e}"),
            Self::Msg(s) => write!(f, "{s}"),
        }
    }
}

impl From<ssh2::Error> for SftpError {
    fn from(value: ssh2::Error) -> Self {
        Self::Ssh(value)
    }
}

impl From<String> for SftpError {
    fn from(value: String) -> Self {
        Self::Msg(value)
    }
}

impl From<std::io::Error> for SftpError {
    fn from(value: std::io::Error) -> Self {
        Self::Msg(value.to_string())
    }
}

impl From<&str> for SftpError {
    fn from(value: &str) -> Self {
        Self::Msg(value.to_string())
    }
}

impl SftpError {
    fn is_transport(&self) -> bool {
        match self {
            Self::Ssh(e) => !matches!(e.code(), ssh2::ErrorCode::SFTP(_)),
            Self::Msg(_) => false,
        }
    }

    fn into_string(self) -> String {
        match self {
            Self::Ssh(e) => e.to_string(),
            Self::Msg(s) => s,
        }
    }
}

pub type SftpSlot = Arc<Mutex<Option<PooledSftp>>>;

fn sftp_slots(state: &Backend, id: &str) -> Result<(Arc<Context>, SftpSlot)> {
    let sessions = state.sessions.lock().map_err(err)?;
    let live = sessions.get(id).ok_or("Session is closed.")?;
    Ok((live.context.clone(), live.sftp.clone()))
}

fn connect_sftp(ctx: &Context) -> Result<PooledSftp> {
    let session = authenticate(ctx)?;
    let sftp = session.sftp().map_err(err)?;
    Ok(PooledSftp {
        sftp,
        _session: session,
    })
}

fn with_sftp<T>(
    ctx: &Context,
    slot: &Mutex<Option<PooledSftp>>,
    mut op: impl FnMut(&Sftp) -> std::result::Result<T, SftpError>,
) -> Result<T> {
    let mut guard = slot.lock().map_err(err)?;
    let mut was_cached = guard.is_some();
    if guard.is_none() {
        *guard = Some(connect_sftp(ctx)?);
    }
    match op(&guard.as_ref().unwrap().sftp) {
        Ok(value) => Ok(value),
        Err(error) if was_cached && error.is_transport() => {
            *guard = None;
            *guard = Some(connect_sftp(ctx)?);
            was_cached = false;
            let _ = was_cached;
            op(&guard.as_ref().unwrap().sftp).map_err(SftpError::into_string)
        }
        Err(error) => {
            if error.is_transport() {
                *guard = None;
            }
            Err(error.into_string())
        }
    }
}

fn normalize_remote(path: &str) -> String {
    let replaced = path.trim().replace('\\', "/");
    if replaced.is_empty() || replaced == "/" {
        return "/".into();
    }
    let trimmed = replaced.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed.into()
    }
}

fn remote_parent(path: &str) -> Option<String> {
    if path == "/" || path == "." {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) => Some("/".into()),
        Some((parent, _)) => Some(parent.into()),
        None => None,
    }
}

fn remote_entry(sftp: &Sftp, path: PathBuf, stat: FileStat) -> FileEntry {
    let symlink = stat.file_type() == ssh2::FileType::Symlink;
    let resolved = if symlink { sftp.stat(&path).ok() } else { None };
    let effective = resolved.as_ref().unwrap_or(&stat);
    FileEntry {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().replace('\\', "/"),
        size: effective.size.unwrap_or(0),
        directory: effective.is_dir(),
        symlink,
        modified: effective.mtime.unwrap_or(0),
        permissions: stat.perm.map(|p| p & 0o7777),
    }
}

pub fn delete_remote_entry(sftp: &Sftp, path: &str, depth: usize) -> Result<()> {
    if depth > 128 {
        return Err("Remote directory tree exceeds maximum deletion depth.".into());
    }
    let clean = path.trim();
    if clean.is_empty() || clean == "/" || clean == "." || clean == ".." {
        return Err("Refusing to delete a root or relative directory.".into());
    }
    let target = Path::new(clean);
    let stat = sftp.lstat(target).map_err(err)?;
    // Unlink symlinks directly so symlinked directories never wipe linked targets.
    if stat.file_type() == ssh2::FileType::Symlink || !stat.is_dir() {
        return sftp.unlink(target).map_err(err);
    }
    let children = sftp.readdir(target).map_err(err)?;
    for (child_path, _) in children {
        let Some(name) = child_path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if matches!(name, "." | "..") {
            continue;
        }
        let child = format!("{}/{}", clean.trim_end_matches('/'), name);
        delete_remote_entry(sftp, &child, depth + 1)?;
    }
    sftp.rmdir(target).map_err(err)
}

#[tauri::command]
pub async fn list_remote(
    state: State<'_, Backend>,
    id: String,
    path: String,
) -> Result<RemoteDirectory> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| {
            let target_path = if path.trim().is_empty() || path.trim() == "." {
                sftp.realpath(Path::new("."))?
                    .to_string_lossy()
                    .replace('\\', "/")
            } else if path.trim().starts_with('~') {
                let home = sftp
                    .realpath(Path::new("."))?
                    .to_string_lossy()
                    .replace('\\', "/");
                let rest = path.trim().trim_start_matches('~').trim_start_matches('/');
                if rest.is_empty() {
                    home
                } else {
                    format!("{}/{}", home.trim_end_matches('/'), rest)
                }
            } else {
                normalize_remote(&path)
            };
            let mut entries: Vec<_> = sftp
                .readdir(Path::new(&target_path))?
                .into_iter()
                .filter(|(p, _)| {
                    !matches!(p.file_name().and_then(|v| v.to_str()), Some("." | ".."))
                })
                .map(|(p, s)| remote_entry(sftp, p, s))
                .collect();
            entries.sort_by(|a, b| {
                b.directory
                    .cmp(&a.directory)
                    .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(RemoteDirectory {
                parent: remote_parent(&target_path),
                path: target_path,
                entries,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn remote_home(state: State<'_, Backend>, id: String) -> Result<String> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| {
            Ok(sftp
                .realpath(Path::new("."))?
                .to_string_lossy()
                .replace('\\', "/"))
        })
    })
    .await
}

#[tauri::command]
pub async fn remote_action(
    state: State<'_, Backend>,
    id: String,
    action: String,
    path: String,
    destination: Option<String>,
    mode: Option<u32>,
) -> Result<()> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| match action.as_str() {
            "mkdir" => {
                sftp.mkdir(Path::new(&path), 0o755)?;
                Ok(())
            }
            "mkfile" => {
                let mut f = sftp.open_mode(
                    Path::new(&path),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                    0o644,
                    ssh2::OpenType::File,
                )?;
                f.close()?;
                Ok(())
            }
            "rename" => {
                let dest = destination
                    .as_deref()
                    .ok_or_else(|| SftpError::Msg("Destination required.".into()))?;
                sftp.rename(
                    Path::new(&path),
                    Path::new(dest),
                    Some(ssh2::RenameFlags::empty()),
                )?;
                Ok(())
            }
            "chmod" => {
                let perm =
                    mode.ok_or_else(|| SftpError::Msg("Permission mode required.".into()))?;
                sftp.setstat(
                    Path::new(&path),
                    FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(perm & 0o7777),
                        atime: None,
                        mtime: None,
                    },
                )?;
                Ok(())
            }
            "duplicate" => {
                let dest = destination
                    .as_deref()
                    .ok_or_else(|| SftpError::Msg("Destination required.".into()))?;
                let src_stat = sftp.stat(Path::new(&path))?;
                if src_stat.is_dir() {
                    return Err(SftpError::Msg(
                        "Only files can be duplicated directly.".into(),
                    ));
                }
                let mut reader = sftp.open(Path::new(&path))?;
                let perm = src_stat.perm.unwrap_or(0o644) as i32 & 0o777;
                let mut writer = sftp.open_mode(
                    Path::new(dest),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                    perm,
                    ssh2::OpenType::File,
                )?;
                let mut buffer = [0u8; 65536];
                loop {
                    let n = reader
                        .read(&mut buffer)
                        .map_err(|e| SftpError::Msg(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    writer
                        .write_all(&buffer[..n])
                        .map_err(|e| SftpError::Msg(e.to_string()))?;
                }
                writer.close()?;
                Ok(())
            }
            "delete" => delete_remote_entry(sftp, &path, 0).map_err(SftpError::Msg),
            _ => Err(SftpError::Msg("Unsupported file operation.".into())),
        })
    })
    .await
}

#[tauri::command]
pub async fn remote_delete_batch(
    state: State<'_, Backend>,
    id: String,
    paths: Vec<String>,
) -> Result<DeleteBatchResult> {
    if paths.is_empty() {
        return Err("Select remote items to delete.".into());
    }
    let (ctx, slot) = sftp_slots(&state, &id)?;
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| {
            let mut deleted = Vec::new();
            let mut failed = Vec::new();
            for item in &paths {
                match delete_remote_entry(sftp, item, 0) {
                    Ok(()) => deleted.push(item.clone()),
                    Err(error) => failed.push(BatchFailure {
                        path: item.clone(),
                        error,
                    }),
                }
            }
            Ok(DeleteBatchResult { deleted, failed })
        })
    })
    .await
}

pub(crate) fn read_remote_sftp(
    sftp: &Sftp,
    path: &str,
    preview_mode: Option<&str>,
) -> std::result::Result<RemoteTextFile, SftpError> {
    let stat = sftp.stat(Path::new(path))?;
    if stat.is_dir() {
        return Err(SftpError::Msg("Selected item is a directory.".into()));
    }
    let total_size = stat.size.unwrap_or(0);
    let mtime = stat.mtime;
    let permissions = stat.perm.map(|p| p & 0o7777);
    let mut file = sftp.open(Path::new(path))?;

    let mut truncated = false;
    let mut active_preview: Option<String> = None;
    let mut bytes = Vec::new();

    if total_size > MAX_EDIT_BYTES {
        truncated = true;
        let mode = preview_mode.unwrap_or("tail");
        active_preview = Some(mode.to_string());
        if mode == "tail" {
            let offset = total_size.saturating_sub(PREVIEW_BYTES);
            file.seek(SeekFrom::Start(offset))?;
        }
        Read::by_ref(&mut file)
            .take(PREVIEW_BYTES)
            .read_to_end(&mut bytes)?;
    } else {
        Read::by_ref(&mut file)
            .take(MAX_EDIT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_EDIT_BYTES {
            bytes.truncate(PREVIEW_BYTES as usize);
            truncated = true;
            active_preview = Some("head".to_string());
        }
    }

    let binary = bytes.iter().take(8192).any(|&b| b == 0);
    if binary {
        return Ok(RemoteTextFile {
            path: path.to_string(),
            text: String::new(),
            mtime,
            size: total_size,
            permissions,
            read_only: true,
            read_only_reason: Some("Binary content detected. Download this file instead.".into()),
            truncated,
            preview_mode: active_preview,
            lossy_utf8: false,
            binary: true,
            line_ending: "LF".into(),
        });
    }

    let (text, lossy_utf8) = match String::from_utf8(bytes) {
        Ok(valid) => (valid, false),
        Err(invalid) => (
            String::from_utf8_lossy(invalid.as_bytes()).into_owned(),
            true,
        ),
    };
    let line_ending = if text.contains("\r\n") { "CRLF" } else { "LF" }.to_string();

    let mut read_only = false;
    let mut read_only_reason = None;
    if truncated {
        read_only = true;
        read_only_reason = Some(format!(
            "File is {:.1} MB — showing {} 512 KB preview (read-only).",
            total_size as f64 / 1_048_576.0,
            if active_preview.as_deref() == Some("head") {
                "first"
            } else {
                "last"
            }
        ));
    } else if lossy_utf8 {
        read_only = true;
        read_only_reason =
            Some("Non-UTF-8 characters detected — opened read-only to prevent corruption.".into());
    }

    Ok(RemoteTextFile {
        path: path.to_string(),
        text,
        mtime,
        size: total_size,
        permissions,
        read_only,
        read_only_reason,
        truncated,
        preview_mode: active_preview,
        lossy_utf8,
        binary: false,
        line_ending,
    })
}

#[tauri::command]
pub async fn read_remote(
    state: State<'_, Backend>,
    id: String,
    path: String,
    preview_mode: Option<String>,
) -> Result<RemoteTextFile> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| {
            read_remote_sftp(sftp, &path, preview_mode.as_deref())
        })
    })
    .await
}

pub(crate) fn write_remote_sftp(
    sftp: &Sftp,
    path: &str,
    bytes: &[u8],
    expected_mtime: Option<u64>,
    force: bool,
) -> std::result::Result<WriteResult, SftpError> {
    let existing = files::remote_stat(sftp, path).map_err(SftpError::Msg)?;
    if !force {
        if let (Some(expected), Some(current)) =
            (expected_mtime, existing.as_ref().and_then(|s| s.mtime))
        {
            if expected != current {
                return Err(SftpError::Msg(format!(
                    "CONFLICT:File changed on server (mtime {current} != {expected})."
                )));
            }
        }
    }
    let perm = existing.as_ref().and_then(|s| s.perm).unwrap_or(0o644) as i32 & 0o777;
    let temp = files::staging_path(path, "part");
    let staged = (|| -> Result<()> {
        let mut target = sftp
            .open_mode(
                Path::new(&temp),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                perm,
                ssh2::OpenType::File,
            )
            .map_err(err)?;
        target.write_all(bytes).map_err(err)?;
        target.close().map_err(err)?;
        files::commit_remote(sftp, &temp, path, existing.is_some())
    })();

    if let Err(stage_err) = staged {
        let _ = sftp.unlink(Path::new(&temp));
        // Fall back to direct truncate only when parent folder disallows staging
        // while the target file itself may still be writable.
        if existing.is_some() {
            let mut direct = sftp
                .open_mode(
                    Path::new(path),
                    ssh2::OpenFlags::WRITE | ssh2::OpenFlags::TRUNCATE,
                    perm,
                    ssh2::OpenType::File,
                )
                .map_err(|_| SftpError::Msg(stage_err))?;
            direct.write_all(bytes)?;
            direct.fsync()?;
            direct.close()?;
        } else {
            return Err(SftpError::Msg(stage_err));
        }
    }
    let updated = sftp.stat(Path::new(path))?;
    Ok(WriteResult {
        mtime: updated.mtime,
        size: updated.size.unwrap_or(bytes.len() as u64),
    })
}

#[tauri::command]
pub async fn write_remote(
    state: State<'_, Backend>,
    id: String,
    path: String,
    text: String,
    expected_mtime: Option<u64>,
    force: Option<bool>,
) -> Result<WriteResult> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    let force_write = force.unwrap_or(false);
    blocking(move || {
        with_sftp(&ctx, &slot, |sftp| {
            write_remote_sftp(sftp, &path, text.as_bytes(), expected_mtime, force_write)
        })
    })
    .await
}

#[tauri::command]
pub async fn open_remote_external(
    app: AppHandle,
    state: State<'_, Backend>,
    id: String,
    path: String,
) -> Result<String> {
    let (ctx, slot) = sftp_slots(&state, &id)?;
    let edit_id = uuid::Uuid::new_v4().to_string();
    let filename = files::remote_item_name(&path)?.to_owned();
    files::download_name(&filename)?;
    let temp_dir = std::env::temp_dir().join(format!("shelldock-edit-{edit_id}"));
    let local_file = temp_dir.join(&filename);
    let remote_path = path.clone();

    let initial_meta = blocking(move || {
        fs::create_dir_all(&temp_dir).map_err(err)?;
        let bytes = with_sftp(&ctx, &slot, |sftp| {
            let stat = sftp.stat(Path::new(&remote_path))?;
            if stat.is_dir() {
                return Err(SftpError::Msg("Selected item is a directory.".into()));
            }
            if stat.size.unwrap_or(0) > 20_000_000 {
                return Err(SftpError::Msg(
                    "External auto-sync edit supports files up to 20 MB.".into(),
                ));
            }
            let mut file = sftp.open(Path::new(&remote_path))?;
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|e| SftpError::Msg(e.to_string()))?;
            Ok(data)
        })?;
        fs::write(&local_file, bytes).map_err(err)?;
        let meta = fs::metadata(&local_file).map_err(err)?;
        let mtime = meta.modified().ok();
        let len = meta.len();
        drag_out::open_with_shell(&local_file)?;
        Ok((temp_dir, local_file, mtime, len, ctx))
    })
    .await?;

    let (temp_dir, local_file, mut last_mtime, mut last_len, ctx) = initial_meta;
    let stop = Arc::new(AtomicBool::new(false));
    state.external_edits.lock().map_err(err)?.insert(
        edit_id.clone(),
        ExternalEditHandle {
            session_id: id.clone(),
            stop: stop.clone(),
            temp_dir: temp_dir.clone(),
        },
    );

    let watcher_id = edit_id.clone();
    let session_id = id.clone();
    let remote_for_thread = path.clone();
    let edits_map = state.external_edits.clone();
    thread::spawn(move || {
        let mut pending_since: Option<SystemTime> = None;
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(500));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(meta) = fs::metadata(&local_file) else {
                continue;
            };
            let mtime = meta.modified().ok();
            let len = meta.len();
            if mtime != last_mtime || len != last_len {
                last_mtime = mtime;
                last_len = len;
                pending_since = Some(SystemTime::now());
            }
            if let Some(since) = pending_since {
                if since.elapsed().unwrap_or_default() >= Duration::from_millis(500) {
                    pending_since = None;
                    let upload_result = (|| -> Result<()> {
                        let bytes = fs::read(&local_file).map_err(err)?;
                        let session = authenticate(&ctx)?;
                        let sftp = session.sftp().map_err(err)?;
                        write_remote_sftp(&sftp, &remote_for_thread, &bytes, None, true)
                            .map(|_| ())
                            .map_err(SftpError::into_string)
                    })();
                    let event = match upload_result {
                        Ok(()) => ExternalEditEvent {
                            edit_id: watcher_id.clone(),
                            session_id: session_id.clone(),
                            path: remote_for_thread.clone(),
                            status: "synced".into(),
                            message: None,
                        },
                        Err(e) => ExternalEditEvent {
                            edit_id: watcher_id.clone(),
                            session_id: session_id.clone(),
                            path: remote_for_thread.clone(),
                            status: "error".into(),
                            message: Some(e),
                        },
                    };
                    let _ = app.emit("remote-edit-event", event);
                }
            }
        }
        if let Ok(mut map) = edits_map.lock() {
            map.remove(&watcher_id);
        }
        let _ = fs::remove_dir_all(&temp_dir);
    });

    Ok(edit_id)
}

#[tauri::command]
pub fn stop_remote_external(state: State<Backend>, edit_id: String) -> Result<()> {
    if let Some(handle) = state.external_edits.lock().map_err(err)?.remove(&edit_id) {
        handle.stop.store(true, Ordering::Relaxed);
        let _ = fs::remove_dir_all(&handle.temp_dir);
    }
    Ok(())
}
