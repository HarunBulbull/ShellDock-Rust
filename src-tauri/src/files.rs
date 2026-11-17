use super::{authenticate, blocking, context, err, Backend, Context, FileEntry, Result};
use serde::{Deserialize, Serialize};
use ssh2::Sftp;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Instant, UNIX_EPOCH},
};
use tauri::{ipc::Channel, State};

fn linked(metadata: &fs::Metadata) -> bool {
    // Windows cloud placeholders are also reparse points, but are not links.
    // Rust's file type distinguishes name-surrogate links/junctions from them.
    metadata.file_type().is_symlink()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectory {
    path: String,
    parent: Option<String>,
    entries: Vec<FileEntry>,
}
fn local_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).into()
    }
}
fn browse(path: &Path) -> Result<LocalDirectory> {
    let path = fs::canonicalize(path).map_err(err)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(err)? {
        let entry = entry.map_err(err)?;
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into(),
            path: local_path(&entry.path()),
            size: metadata.len(),
            directory: metadata.is_dir(),
            symlink: linked(&metadata),
            modified: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_secs())
                .unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(LocalDirectory {
        parent: path.parent().map(local_path),
        path: local_path(&path),
        entries,
    })
}
#[tauri::command]
pub async fn list_local(path: Option<String>) -> Result<LocalDirectory> {
    blocking(move || {
        let folder = path
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or("Choose a local folder.")?;
        browse(&folder)
    })
    .await
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub job_id: String,
    pub sources: Vec<String>,
    pub destination: String,
    pub upload: bool,
    pub policy: String,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub completed_files: u64,
    pub total_files: u64,
    pub skipped_files: u64,
    pub current: String,
    pub status: String,
}
struct Item {
    local: PathBuf,
    remote: String,
    directory: bool,
    size: u64,
}
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err("Transfer cancelled.".into())
    } else {
        Ok(())
    }
}
fn remote_join(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
}
fn staging_path(destination: &str, extension: &str) -> String {
    let parent = destination
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    remote_join(
        parent,
        &format!(".shelldock-{}.{extension}", uuid::Uuid::new_v4()),
    )
}
fn name(path: &str) -> Result<&str> {
    let value = path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .ok_or("Cannot transfer a filesystem root.")?;
    validate_name(value)?;
    Ok(value)
}
fn validate_name(value: &str) -> Result<()> {
    if value.is_empty() || matches!(value, "." | "..") || value.contains(['/', '\\', '\0']) {
        return Err("Unsafe transfer filename.".into());
    }
    Ok(())
}
fn download_name(value: &str) -> Result<()> {
    validate_name(value)?;
    #[cfg(windows)]
    {
        let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
        if value.contains([':', '*', '?', '"', '<', '>', '|'])
            || value.ends_with([' ', '.'])
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        {
            return Err(format!("Filename cannot be saved on Windows: {value}"));
        }
    }
    Ok(())
}
fn remote_stat(sftp: &Sftp, path: &str) -> Result<Option<ssh2::FileStat>> {
    match sftp.lstat(Path::new(path)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if matches!(e.code(), ssh2::ErrorCode::SFTP(2 | 10)) => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn plan_upload(
    local: &Path,
    remote: String,
    items: &mut Vec<Item>,
    state: &mut BatchProgress,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<()> {
    check(cancel)?;
    if depth > 128 || items.len() > 100_000 {
        return Err("Transfer tree exceeds the planning limit.".into());
    }
    let metadata = fs::symlink_metadata(local).map_err(err)?;
    if linked(&metadata) {
        state.skipped_files += 1;
        return Ok(());
    }
    if !metadata.is_dir() && !metadata.is_file() {
        return Err("Only regular files and folders can be transferred.".into());
    }
    let directory = metadata.is_dir();
    items.push(Item {
        local: local.into(),
        remote: remote.clone(),
        directory,
        size: if directory { 0 } else { metadata.len() },
    });
    if directory {
        let mut children = fs::read_dir(local)
            .map_err(err)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(err)?;
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            let filename = entry.file_name();
            let filename = filename.to_str().ok_or("Filename is not valid UTF-8.")?;
            validate_name(filename)?;
            plan_upload(
                &entry.path(),
                remote_join(&remote, filename),
                items,
                state,
                cancel,
                depth + 1,
            )?;
        }
    }
    Ok(())
}
fn plan_download(
    sftp: &Sftp,
    remote: &str,
    local: PathBuf,
    items: &mut Vec<Item>,
    state: &mut BatchProgress,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<()> {
    check(cancel)?;
    if depth > 128 || items.len() > 100_000 {
        return Err("Transfer tree exceeds the planning limit.".into());
    }
    let stat = sftp.lstat(Path::new(remote)).map_err(err)?;
    if stat.file_type() == ssh2::FileType::Symlink {
        state.skipped_files += 1;
        return Ok(());
    }
    let directory = stat.is_dir();
    if !directory && !stat.is_file() {
        return Err("Only regular files and folders can be transferred.".into());
    }
    items.push(Item {
        local: local.clone(),
        remote: remote.into(),
        directory,
        size: stat.size.unwrap_or(0),
    });
    if directory {
        let mut children = sftp.readdir(Path::new(remote)).map_err(err)?;
        children.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, _) in children {
            let filename = path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("Invalid remote filename.")?;
            if matches!(filename, "." | "..") {
                continue;
            }
            download_name(filename)?;
            plan_download(
                sftp,
                &remote_join(remote, filename),
                local.join(filename),
                items,
                state,
                cancel,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn copy_stream(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    state: &mut BatchProgress,
    cancel: &AtomicBool,
    report: &mut impl FnMut(&BatchProgress),
) -> Result<()> {
    let mut bytes = [0; 65536];
    let mut last = Instant::now();
    loop {
        check(cancel)?;
        let n = reader.read(&mut bytes).map_err(err)?;
        if n == 0 {
            break;
        }
        writer.write_all(&bytes[..n]).map_err(err)?;
        state.completed_bytes += n as u64;
        if last.elapsed().as_millis() >= 100 {
            report(state);
            last = Instant::now();
        }
    }
    writer.flush().map_err(err)
}
fn commit_remote(sftp: &Sftp, temp: &str, destination: &str, replace_existing: bool) -> Result<()> {
    if !replace_existing {
        return sftp
            .rename(
                Path::new(temp),
                Path::new(destination),
                Some(ssh2::RenameFlags::empty()),
            )
            .map_err(err);
    }
    // SFTP v3 does not provide portable overwrite flags. Preserve the old file
    // until the staged file is installed, and restore it if the second rename fails.
    let backup = staging_path(destination, "backup");
    sftp.rename(
        Path::new(destination),
        Path::new(&backup),
        Some(ssh2::RenameFlags::empty()),
    )
    .map_err(err)?;
    if let Err(error) = sftp.rename(
        Path::new(temp),
        Path::new(destination),
        Some(ssh2::RenameFlags::empty()),
    ) {
        return match sftp.rename(
            Path::new(&backup),
            Path::new(destination),
            Some(ssh2::RenameFlags::empty()),
        ) {
            Ok(()) => Err(format!("Replacement failed; original restored: {error}")),
            Err(_) => Err(format!(
                "Replacement failed. Original is preserved at {backup}: {error}"
            )),
        };
    }
    sftp.unlink(Path::new(&backup)).map_err(|error| {
        format!("File replaced, but the original backup could not be removed: {backup}: {error}")
    })
}

pub fn run_batch(
    ctx: &Context,
    request: &BatchRequest,
    cancel: &AtomicBool,
    mut report: impl FnMut(&BatchProgress),
) -> Result<BatchProgress> {
    if request.sources.is_empty() {
        return Err("Select files or folders to transfer.".into());
    }
    if !["skip", "replace"].contains(&request.policy.as_str()) {
        return Err("Select Skip or Replace for existing files.".into());
    }
    let mut state = BatchProgress {
        status: "planning".into(),
        ..Default::default()
    };
    report(&state);
    check(cancel)?;
    let session = authenticate(ctx)?;
    let sftp = session.sftp().map_err(err)?;
    let mut items = Vec::new();
    let destination = Path::new(&request.destination);
    if !request.upload && !destination.is_dir() {
        return Err("Choose an existing local destination folder.".into());
    }
    let mut roots = std::collections::HashSet::new();
    for source in &request.sources {
        if request.upload {
            let path = Path::new(source);
            let filename = path
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("Cannot transfer a filesystem root.")?;
            validate_name(filename)?;
            if !roots.insert(filename.to_owned()) {
                return Err(
                    "Selected roots have duplicate names. Transfer them separately.".into(),
                );
            }
            plan_upload(
                path,
                remote_join(&request.destination, filename),
                &mut items,
                &mut state,
                cancel,
                0,
            )?;
        } else {
            let filename = name(source)?;
            download_name(filename)?;
            if !roots.insert(filename.to_owned()) {
                return Err("Selected roots have duplicate names.".into());
            }
            plan_download(
                &sftp,
                source,
                destination.join(filename),
                &mut items,
                &mut state,
                cancel,
                0,
            )?;
        }
    }
    state.total_files = items.iter().filter(|i| !i.directory).count() as u64 + state.skipped_files;
    state.total_bytes = items.iter().filter(|i| !i.directory).map(|i| i.size).sum();
    state.status = "transferring".into();
    report(&state);
    let result = (|| -> Result<()> {
        for item in &items {
            check(cancel)?;
            state.current = if request.upload {
                item.local.to_string_lossy().into()
            } else {
                item.remote.clone()
            };
            report(&state);
            if item.directory {
                if request.upload {
                    match remote_stat(&sftp, &item.remote)? {
                        Some(stat) if stat.is_dir() => (),
                        Some(_) => {
                            return Err(format!("A non-folder already exists at {}", item.remote))
                        }
                        None => sftp.mkdir(Path::new(&item.remote), 0o755).map_err(err)?,
                    }
                } else {
                    if let Ok(metadata) = fs::symlink_metadata(&item.local) {
                        if linked(&metadata) || !metadata.is_dir() {
                            return Err("Local destination contains a link or non-folder.".into());
                        }
                    }
                    fs::create_dir_all(&item.local).map_err(err)?;
                }
                continue;
            }
            if request.upload {
                let existing = remote_stat(&sftp, &item.remote)?;
                if let Some(stat) = &existing {
                    if stat.is_dir() || stat.file_type() == ssh2::FileType::Symlink {
                        return Err(format!(
                            "Refusing to replace folder or link: {}",
                            item.remote
                        ));
                    }
                    if request.policy == "skip" {
                        state.skipped_files += 1;
                        report(&state);
                        continue;
                    }
                }
                let temp = staging_path(&item.remote, "part");
                let copied = (|| -> Result<()> {
                    let mut source = fs::File::open(&item.local).map_err(err)?;
                    let mut target = sftp
                        .open_mode(
                            Path::new(&temp),
                            ssh2::OpenFlags::WRITE
                                | ssh2::OpenFlags::CREATE
                                | ssh2::OpenFlags::EXCLUSIVE,
                            existing.as_ref().and_then(|s| s.perm).unwrap_or(0o644) as i32 & 0o777,
                            ssh2::OpenType::File,
                        )
                        .map_err(err)?;
                    copy_stream(&mut source, &mut target, &mut state, cancel, &mut report)?;
                    target.close().map_err(err)?;
                    check(cancel)?;
                    commit_remote(
                        &sftp,
                        &temp,
                        &item.remote,
                        request.policy == "replace" && existing.is_some(),
                    )
                })();
                if copied.is_err() {
                    let _ = sftp.unlink(Path::new(&temp));
                }
                copied?;
            } else {
                if let Ok(metadata) = fs::symlink_metadata(&item.local) {
                    if linked(&metadata) || !metadata.is_file() {
                        return Err("Refusing to replace local folder or link.".into());
                    }
                    if request.policy == "skip" {
                        state.skipped_files += 1;
                        report(&state);
                        continue;
                    }
                }
                let temp = item
                    .local
                    .with_file_name(format!(".shelldock-{}.part", uuid::Uuid::new_v4()));
                let copied = (|| -> Result<()> {
                    let mut source = sftp.open(Path::new(&item.remote)).map_err(err)?;
                    let mut target = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temp)
                        .map_err(err)?;
                    copy_stream(&mut source, &mut target, &mut state, cancel, &mut report)?;
                    target.sync_all().map_err(err)?;
                    drop(target);
                    check(cancel)?;
                    if request.policy == "replace" {
                        fs::rename(&temp, &item.local).map_err(err)
                    } else {
                        fs::hard_link(&temp, &item.local).map_err(err)?;
                        fs::remove_file(&temp).map_err(err)
                    }
                })();
                if copied.is_err() {
                    let _ = fs::remove_file(&temp);
                }
                copied?;
            }
            state.completed_files += 1;
            report(&state);
        }
        Ok(())
    })();
    if let Err(e) = result {
        state.status = if cancel.load(Ordering::Relaxed) {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        report(&state);
        return Err(e);
    }
    state.status = "completed".into();
    state.current.clear();
    report(&state);
    Ok(state)
}

#[tauri::command]
pub async fn transfer_batch(
    state: State<'_, Backend>,
    id: String,
    request: BatchRequest,
    progress: Channel<BatchProgress>,
) -> Result<BatchProgress> {
    let ctx = context(&state, &id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.transfers.lock().map_err(err)?;
        if jobs.contains_key(&request.job_id) {
            return Err("Transfer already exists.".into());
        }
        jobs.insert(request.job_id.clone(), cancel.clone());
    }
    let key = request.job_id.clone();
    let result = blocking(move || {
        run_batch(&ctx, &request, &cancel, |value| {
            let _ = progress.send(value.clone());
        })
    })
    .await;
    state.transfers.lock().map_err(err)?.remove(&key);
    result
}
#[tauri::command]
pub fn cancel_transfer(state: State<Backend>, job_id: String) -> Result<()> {
    if let Some(cancel) = state.transfers.lock().map_err(err)?.get(&job_id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_browser_lists_and_sorts_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("test.txt"), b"hello").unwrap();
        fs::create_dir(dir.path().join("folder")).unwrap();
        let listing = browse(dir.path()).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries[0].directory);
        assert_eq!(listing.entries[1].size, 5);
        assert!(listing.parent.is_some());
    }
    #[test]
    fn rejects_traversal_filenames() {
        for value in ["..", ".", "a/b", "a\\b", ""] {
            assert!(validate_name(value).is_err());
        }
    }
}
