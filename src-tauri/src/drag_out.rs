use crate::{authenticate, blocking, context, err, sftp::PooledSftp, Backend, Context, Result};
use serde::{Deserialize, Serialize};
use ssh2::{FileStat, Sftp};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlaces {
    pub home: String,
    pub desktop: Option<String>,
    pub downloads: Option<String>,
    pub documents: Option<String>,
    pub drives: Vec<DriveInfo>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragRootHint {
    pub path: String,
    pub directory: bool,
    pub size: u64,
}

fn existing_dir(path: PathBuf) -> Option<String> {
    path.is_dir().then(|| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_local_places() -> Result<LocalPlaces> {
    let home_dir = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("Home directory could not be determined.")?;
    let home = home_dir.to_string_lossy().into_owned();
    let desktop = existing_dir(home_dir.join("Desktop"));
    let downloads = existing_dir(home_dir.join("Downloads"));
    let documents = existing_dir(home_dir.join("Documents"));
    let drives = enumerate_drives();
    Ok(LocalPlaces {
        home,
        desktop,
        downloads,
        documents,
        drives,
    })
}

#[cfg(windows)]
fn enumerate_drives() -> Vec<DriveInfo> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows_core::PCWSTR;
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for index in 0..26u8 {
        if (mask & (1 << index)) == 0 {
            continue;
        }
        let letter = (b'A' + index) as char;
        let path = format!("{letter}:\\");
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // 0 = DRIVE_UNKNOWN, 1 = DRIVE_NO_ROOT_DIR
        if kind > 1 {
            drives.push(DriveInfo {
                label: format!("{letter}:"),
                path,
            });
        }
    }
    drives
}

#[cfg(not(windows))]
fn enumerate_drives() -> Vec<DriveInfo> {
    vec![DriveInfo {
        path: "/".into(),
        label: "/".into(),
    }]
}

#[cfg(windows)]
pub fn open_with_shell(path: &Path) -> Result<()> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows_core::{w, PCWSTR};
    let wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result.0 as usize) <= 32 {
        return Err(format!(
            "Windows could not open “{}” (error code {}).",
            path.display(),
            result.0 as usize
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn open_with_shell(_path: &Path) -> Result<()> {
    Err("Opening files in the default app is only supported on Windows.".into())
}

#[tauri::command]
pub fn open_local_default(path: String) -> Result<()> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("Selected local file does not exist.".into());
    }
    open_with_shell(target)
}

#[tauri::command]
pub fn reveal_local(path: String) -> Result<()> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("Selected local path does not exist.".into());
    }
    #[cfg(windows)]
    {
        let canonical = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
        let cleaned = canonical
            .to_string_lossy()
            .strip_prefix("\\\\?\\")
            .unwrap_or(&canonical.to_string_lossy())
            .to_string();
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{cleaned}"))
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("Reveal in Explorer is only supported on Windows.".into())
    }
}

#[derive(Clone)]
pub(crate) struct DragEntry {
    pub(crate) remote_path: String,
    pub(crate) relative_windows_path: String,
    pub(crate) directory: bool,
    pub(crate) size: u64,
}

fn collect_drag_entry(
    sftp: &Sftp,
    remote: &str,
    relative: String,
    stat_hint: Option<&FileStat>,
    items: &mut Vec<DragEntry>,
    cancel: &AtomicBool,
    depth: usize,
) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err("External drag cancelled.".into());
    }
    if depth > 128 {
        return Err("Dragged directory tree exceeds maximum nesting depth.".into());
    }
    if relative.encode_utf16().count() >= 259 {
        return Err(format!(
            "A dragged path exceeds Windows filename limits: {relative}"
        ));
    }
    let fetched;
    let stat = match stat_hint.filter(|s| s.perm.is_some()) {
        Some(s) => s,
        None => {
            fetched = sftp.lstat(Path::new(remote)).map_err(err)?;
            &fetched
        }
    };
    if stat.file_type() == ssh2::FileType::Symlink {
        return Ok(());
    }
    let directory = stat.is_dir();
    if !directory && !stat.is_file() {
        return Ok(());
    }
    items.push(DragEntry {
        remote_path: remote.to_string(),
        relative_windows_path: relative.clone(),
        directory,
        size: if directory { 0 } else { stat.size.unwrap_or(0) },
    });
    if directory {
        let mut children = sftp.readdir(Path::new(remote)).map_err(err)?;
        children.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, child_stat) in children {
            let Some(filename) = path.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            if matches!(filename, "." | "..") {
                continue;
            }
            let next_remote = format!("{}/{}", remote.trim_end_matches('/'), filename);
            crate::files::download_name(filename).map_err(|e| format!("{e} ({next_remote})"))?;
            let next_relative = format!("{relative}\\{filename}");
            collect_drag_entry(
                sftp,
                &next_remote,
                next_relative,
                Some(&child_stat),
                items,
                cancel,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn collect_all_drag_entries(
    sftp: &Sftp,
    roots: &[DragEntry],
    cancel: &AtomicBool,
) -> Result<Vec<DragEntry>> {
    let mut items = Vec::with_capacity(roots.len());
    for root in roots {
        collect_drag_entry(
            sftp,
            &root.remote_path,
            root.relative_windows_path.clone(),
            None,
            &mut items,
            cancel,
            0,
        )?;
    }
    Ok(items)
}

fn build_root_entries(
    paths: Vec<String>,
    roots: Option<&[DragRootHint]>,
) -> Result<Vec<DragEntry>> {
    let hint_map: std::collections::HashMap<&str, &DragRootHint> = roots
        .unwrap_or(&[])
        .iter()
        .map(|r| (r.path.as_str(), r))
        .collect();

    let mut root_entries = Vec::with_capacity(paths.len());
    let mut seen_roots = std::collections::HashSet::new();
    for source in paths {
        let root_name = crate::files::remote_item_name(&source)?.to_owned();
        crate::files::download_name(&root_name)?;
        if !seen_roots.insert(root_name.clone()) {
            return Err("Selected roots have duplicate names.".into());
        }
        let hint = hint_map.get(source.as_str()).copied();
        root_entries.push(DragEntry {
            remote_path: source,
            relative_windows_path: root_name,
            directory: hint.map(|h| h.directory).unwrap_or(true),
            size: hint
                .map(|h| if h.directory { 0 } else { h.size })
                .unwrap_or(0),
        });
    }
    Ok(root_entries)
}

#[tauri::command]
pub async fn start_external_drag(
    app: AppHandle,
    state: State<'_, Backend>,
    id: String,
    paths: Vec<String>,
    roots: Option<Vec<DragRootHint>>,
) -> Result<bool> {
    if paths.is_empty() {
        return Ok(false);
    }
    let ctx = context(&state, &id)?;
    let root_entries = build_root_entries(paths, roots.as_deref())?;

    #[cfg(windows)]
    {
        blocking(move || win_drag::run_ole_drag(app, root_entries, ctx)).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, root_entries, ctx);
        Ok(false)
    }
}

#[cfg(windows)]
mod win_drag {
    use super::*;
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DV_E_FORMATETC, E_ABORT, E_FAIL, E_INVALIDARG,
        E_NOTIMPL, E_POINTER, HGLOBAL, POINTL, SIZE, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION,
        S_FALSE, S_OK,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl,
        IEnumFORMATETC, IEnumSTATDATA, ISequentialStream, ISequentialStream_Impl, IStream,
        IStream_Impl,
        Marshal::{CoMarshalInterThreadInterfaceInStream, CoReleaseMarshalData},
        StructuredStorage::CoGetInterfaceAndReleaseStream,
        COINIT_MULTITHREADED, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG,
        STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, TYMED_HGLOBAL,
        TYMED_ISTREAM,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows::Win32::System::Ole::{
        IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, ReleaseStgMedium,
        DROPEFFECT, DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_RBUTTON,
    };
    use windows::Win32::UI::Shell::{
        IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, SHCreateStdEnumFmtEtc,
        SHDoDragDrop, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_TARGETCLSID, FD_ATTRIBUTES,
        FD_FILESIZE, FD_PROGRESSUI, FILEDESCRIPTORW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    use windows_core::{implement, Interface, Ref, BOOL, HRESULT};

    const STREAM_BUFFER_THRESHOLD: u64 = 2 * 1024 * 1024;
    const STREAM_CHUNK_BYTES: usize = 65_536;
    const STREAM_CHANNEL_CHUNKS: usize = 32;

    pub(super) struct OleGuard;
    impl Drop for OleGuard {
        fn drop(&mut self) {
            unsafe { OleUninitialize() };
        }
    }

    struct ComMtaGuard;
    impl Drop for ComMtaGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct StoredMedium {
        fmt: FORMATETC,
        med: STGMEDIUM,
    }
    unsafe impl Send for StoredMedium {}
    impl Drop for StoredMedium {
        fn drop(&mut self) {
            unsafe { ReleaseStgMedium(&mut self.med) };
        }
    }

    #[implement(ISequentialStream, IStream)]
    struct MemStream {
        data: Arc<Vec<u8>>,
        pos: Mutex<usize>,
    }

    impl ISequentialStream_Impl for MemStream_Impl {
        fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
            if pv.is_null() && cb > 0 {
                return E_POINTER;
            }
            let mut pos = self.pos.lock().unwrap();
            let avail = self.data.len().saturating_sub(*pos);
            let n = avail.min(cb as usize);
            if n > 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(self.data[*pos..].as_ptr(), pv as *mut u8, n);
                }
            }
            *pos += n;
            if !pcbread.is_null() {
                unsafe { *pcbread = n as u32 };
            }
            if n < cb as usize {
                S_FALSE
            } else {
                S_OK
            }
        }

        fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
            STG_E_ACCESSDENIED
        }
    }

    impl IStream_Impl for MemStream_Impl {
        fn Seek(
            &self,
            dlibmove: i64,
            dworigin: STREAM_SEEK,
            plibnewposition: *mut u64,
        ) -> windows_core::Result<()> {
            let mut pos = self.pos.lock().unwrap();
            let base = match dworigin.0 {
                0 => 0i64,
                1 => *pos as i64,
                2 => self.data.len() as i64,
                _ => return Err(STG_E_INVALIDFUNCTION.into()),
            };
            let next = base.checked_add(dlibmove).ok_or(STG_E_INVALIDFUNCTION)?;
            if next < 0 {
                return Err(STG_E_INVALIDFUNCTION.into());
            }
            *pos = next as usize;
            if !plibnewposition.is_null() {
                unsafe { *plibnewposition = next as u64 };
            }
            Ok(())
        }

        fn SetSize(&self, _: u64) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn CopyTo(
            &self,
            _: Ref<IStream>,
            _: u64,
            _: *mut u64,
            _: *mut u64,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Commit(&self, _: &STGC) -> windows_core::Result<()> {
            Ok(())
        }

        fn Revert(&self) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Stat(&self, pstatstg: *mut STATSTG, _: &STATFLAG) -> windows_core::Result<()> {
            if pstatstg.is_null() {
                return Err(E_POINTER.into());
            }
            unsafe {
                *pstatstg = STATSTG {
                    r#type: STGTY_STREAM.0 as u32,
                    cbSize: self.data.len() as u64,
                    ..Default::default()
                };
            }
            Ok(())
        }

        fn Clone(&self) -> windows_core::Result<IStream> {
            let pos = *self.pos.lock().unwrap();
            Ok(MemStream {
                data: self.data.clone(),
                pos: Mutex::new(pos),
            }
            .into())
        }
    }

    struct StreamReaderState {
        rx: mpsc::Receiver<std::result::Result<Vec<u8>, String>>,
        current: Vec<u8>,
        offset: usize,
        eof: bool,
        pos: u64,
    }

    #[implement(ISequentialStream, IStream)]
    struct StreamingSftpStream {
        size: u64,
        state: Mutex<StreamReaderState>,
        cancel: Arc<AtomicBool>,
        error_reporter: Arc<dyn Fn(&str) + Send + Sync>,
    }

    impl Drop for StreamingSftpStream {
        fn drop(&mut self) {
            // Closing receiver signals the worker to stop if still reading early.
        }
    }

    impl ISequentialStream_Impl for StreamingSftpStream_Impl {
        fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
            if pv.is_null() && cb > 0 {
                return E_POINTER;
            }
            let want = cb as usize;
            let mut written = 0usize;
            let mut st = self.state.lock().unwrap();
            while written < want {
                if self.cancel.load(Ordering::Relaxed) {
                    if !pcbread.is_null() {
                        unsafe { *pcbread = written as u32 };
                    }
                    return E_ABORT;
                }
                if st.offset < st.current.len() {
                    let take = (want - written).min(st.current.len() - st.offset);
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            st.current[st.offset..].as_ptr(),
                            (pv as *mut u8).add(written),
                            take,
                        );
                    }
                    st.offset += take;
                    st.pos += take as u64;
                    written += take;
                    continue;
                }
                if st.eof {
                    break;
                }
                match st.rx.recv() {
                    Ok(Ok(chunk)) => {
                        if chunk.is_empty() {
                            st.eof = true;
                        } else {
                            st.current = chunk;
                            st.offset = 0;
                        }
                    }
                    Ok(Err(msg)) => {
                        (self.error_reporter)(&msg);
                        if !pcbread.is_null() {
                            unsafe { *pcbread = written as u32 };
                        }
                        return E_FAIL;
                    }
                    Err(_) => {
                        st.eof = true;
                    }
                }
            }
            if !pcbread.is_null() {
                unsafe { *pcbread = written as u32 };
            }
            if written < want {
                S_FALSE
            } else {
                S_OK
            }
        }

        fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
            STG_E_ACCESSDENIED
        }
    }

    impl IStream_Impl for StreamingSftpStream_Impl {
        fn Seek(
            &self,
            dlibmove: i64,
            dworigin: STREAM_SEEK,
            plibnewposition: *mut u64,
        ) -> windows_core::Result<()> {
            let st = self.state.lock().unwrap();
            let target = match dworigin.0 {
                0 => dlibmove,
                1 => (st.pos as i64).saturating_add(dlibmove),
                2 => (self.size as i64).saturating_add(dlibmove),
                _ => return Err(STG_E_INVALIDFUNCTION.into()),
            };
            if target < 0 || target as u64 != st.pos {
                return Err(STG_E_INVALIDFUNCTION.into());
            }
            if !plibnewposition.is_null() {
                unsafe { *plibnewposition = st.pos };
            }
            Ok(())
        }

        fn SetSize(&self, _: u64) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn CopyTo(
            &self,
            _: Ref<IStream>,
            _: u64,
            _: *mut u64,
            _: *mut u64,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Commit(&self, _: &STGC) -> windows_core::Result<()> {
            Ok(())
        }

        fn Revert(&self) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Stat(&self, pstatstg: *mut STATSTG, _: &STATFLAG) -> windows_core::Result<()> {
            if pstatstg.is_null() {
                return Err(E_POINTER.into());
            }
            unsafe {
                *pstatstg = STATSTG {
                    r#type: STGTY_STREAM.0 as u32,
                    cbSize: self.size,
                    ..Default::default()
                };
            }
            Ok(())
        }

        fn Clone(&self) -> windows_core::Result<IStream> {
            Err(E_NOTIMPL.into())
        }
    }

    #[implement(IDropSource)]
    struct RemoteDropSource {
        drop_signaled: Arc<AtomicBool>,
    }

    impl IDropSource_Impl for RemoteDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if fescapepressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            // WM_LBUTTONDOWN occurs in the out-of-process WebView2 HWND, so
            // grfkeystate may omit MK_LBUTTON at drag start; also check global state.
            let primary_vk = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
                VK_RBUTTON.0 as i32
            } else {
                VK_LBUTTON.0 as i32
            };
            let physical_down = unsafe { (GetAsyncKeyState(primary_vk) as u16 & 0x8000) != 0 };
            if (grfkeystate.0 & MK_LBUTTON.0) == 0 && !physical_down {
                self.drop_signaled.store(true, Ordering::SeqCst);
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            windows::Win32::Foundation::DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    #[implement(IDataObject, IDataObjectAsyncCapability)]
    struct RemoteDataObject {
        root_entries: Vec<DragEntry>,
        full_entries: Mutex<Option<Arc<Vec<DragEntry>>>>,
        ctx: Arc<Context>,
        sftp_pool: Arc<Mutex<Vec<PooledSftp>>>,
        cf_descriptor: u16,
        cf_contents: u16,
        cf_target_clsid: u16,
        async_mode: AtomicBool,
        in_operation: AtomicBool,
        drop_signaled: Arc<AtomicBool>,
        cancel: Arc<AtomicBool>,
        stored_media: Mutex<Vec<StoredMedium>>,
        done_signal: Arc<(Mutex<bool>, Condvar)>,
        error_reporter: Arc<dyn Fn(&str) + Send + Sync>,
    }

    impl Drop for RemoteDataObject {
        fn drop(&mut self) {
            self.cancel.store(true, Ordering::Relaxed);
            self.stored_media.lock().unwrap().clear();
            let (lock, cvar) = &*self.done_signal;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
    }

    impl RemoteDataObject {
        fn checkout_sftp(&self) -> Result<PooledSftp> {
            if let Some(pooled) = self.sftp_pool.lock().unwrap().pop() {
                return Ok(pooled);
            }
            let session = authenticate(&self.ctx)?;
            let sftp = session.sftp().map_err(err)?;
            Ok(PooledSftp {
                sftp,
                _session: session,
            })
        }

        fn checkin_sftp(&self, pooled: PooledSftp) {
            let mut pool = self.sftp_pool.lock().unwrap();
            if pool.len() < 4 {
                pool.push(pooled);
            }
        }

        fn ensure_full_entries(&self) -> windows_core::Result<Arc<Vec<DragEntry>>> {
            let mut guard = self.full_entries.lock().unwrap();
            if let Some(existing) = guard.as_ref() {
                return Ok(existing.clone());
            }
            let mut attempt = 0;
            let scanned = loop {
                let pooled = match self.checkout_sftp() {
                    Ok(p) => p,
                    Err(e) => {
                        (self.error_reporter)(&e);
                        return Err(E_FAIL.into());
                    }
                };
                match collect_all_drag_entries(&pooled.sftp, &self.root_entries, &self.cancel) {
                    Ok(entries) => {
                        self.checkin_sftp(pooled);
                        break entries;
                    }
                    Err(e) => {
                        // Drop the potentially stale pooled session and retry once.
                        if attempt == 0 && !self.cancel.load(Ordering::Relaxed) {
                            attempt += 1;
                            continue;
                        }
                        (self.error_reporter)(&e);
                        return Err(if self.cancel.load(Ordering::Relaxed) {
                            E_ABORT.into()
                        } else {
                            E_FAIL.into()
                        });
                    }
                }
            };
            let arc = Arc::new(scanned);
            *guard = Some(arc.clone());
            Ok(arc)
        }

        fn active_entries(&self) -> windows_core::Result<Vec<DragEntry>> {
            if self.drop_signaled.load(Ordering::SeqCst) || self.in_operation.load(Ordering::SeqCst)
            {
                Ok(self.ensure_full_entries()?.as_ref().clone())
            } else {
                Ok(self.root_entries.clone())
            }
        }

        fn format_list(&self) -> Vec<FORMATETC> {
            let mut list = vec![
                FORMATETC {
                    cfFormat: self.cf_descriptor,
                    ptd: std::ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                },
                FORMATETC {
                    cfFormat: self.cf_contents,
                    ptd: std::ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_ISTREAM.0 as u32,
                },
            ];
            for stored in self.stored_media.lock().unwrap().iter() {
                if !list.iter().any(|f| {
                    f.cfFormat == stored.fmt.cfFormat
                        && f.dwAspect == stored.fmt.dwAspect
                        && f.lindex == stored.fmt.lindex
                }) {
                    list.push(stored.fmt);
                }
            }
            list
        }

        fn matches_descriptor(&self, fmt: &FORMATETC) -> bool {
            fmt.cfFormat == self.cf_descriptor
                && (fmt.tymed & (TYMED_HGLOBAL.0 as u32)) != 0
                && fmt.dwAspect == DVASPECT_CONTENT.0
        }

        fn matches_contents(&self, fmt: &FORMATETC, allow_wildcard_index: bool) -> bool {
            let valid_index = if allow_wildcard_index && fmt.lindex == -1 {
                true
            } else if fmt.lindex >= 0 {
                if let Some(full) = self.full_entries.lock().unwrap().as_ref() {
                    (fmt.lindex as usize) < full.len()
                } else {
                    true
                }
            } else {
                false
            };
            fmt.cfFormat == self.cf_contents
                && (fmt.tymed & (TYMED_ISTREAM.0 as u32)) != 0
                && fmt.dwAspect == DVASPECT_CONTENT.0
                && valid_index
        }

        fn build_descriptor_medium(&self) -> windows_core::Result<STGMEDIUM> {
            let entries = self.active_entries()?;
            let item_size = std::mem::size_of::<FILEDESCRIPTORW>();
            let total_bytes = 4 + entries.len() * item_size;
            let hglobal: HGLOBAL =
                unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes) }?;
            let ptr = unsafe { GlobalLock(hglobal) } as *mut u8;
            if ptr.is_null() {
                return Err(windows::Win32::Foundation::E_OUTOFMEMORY.into());
            }
            unsafe {
                std::ptr::write_unaligned(ptr as *mut u32, entries.len() as u32);
                for (index, entry) in entries.iter().enumerate() {
                    let mut wide_name = [0u16; 260];
                    for (slot, unit) in wide_name
                        .iter_mut()
                        .zip(entry.relative_windows_path.encode_utf16())
                        .take(259)
                    {
                        *slot = unit;
                    }
                    let desc = FILEDESCRIPTORW {
                        dwFlags: if entry.directory {
                            FD_ATTRIBUTES.0 as u32
                        } else {
                            (FD_ATTRIBUTES.0 | FD_FILESIZE.0 | FD_PROGRESSUI.0) as u32
                        },
                        clsid: Default::default(),
                        sizel: SIZE::default(),
                        pointl: POINTL::default(),
                        dwFileAttributes: if entry.directory {
                            FILE_ATTRIBUTE_DIRECTORY.0
                        } else {
                            FILE_ATTRIBUTE_NORMAL.0
                        },
                        ftCreationTime: Default::default(),
                        ftLastAccessTime: Default::default(),
                        ftLastWriteTime: Default::default(),
                        nFileSizeHigh: (entry.size >> 32) as u32,
                        nFileSizeLow: (entry.size & 0xFFFF_FFFF) as u32,
                        cFileName: wide_name,
                    };
                    std::ptr::write_unaligned(
                        ptr.add(4 + index * item_size) as *mut FILEDESCRIPTORW,
                        desc,
                    );
                }
                let _ = GlobalUnlock(hglobal);
            }
            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: hglobal },
                pUnkForRelease: core::mem::ManuallyDrop::new(None),
            })
        }

        fn build_contents_stream(&self, index: usize) -> windows_core::Result<STGMEDIUM> {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(E_ABORT.into());
            }
            let entries = self.ensure_full_entries()?;
            let entry = entries
                .get(index)
                .ok_or_else(|| windows_core::Error::from(DV_E_FORMATETC))?
                .clone();
            if entry.directory {
                return Err(DV_E_FORMATETC.into());
            }

            let stream: IStream = if entry.size <= STREAM_BUFFER_THRESHOLD {
                let mut attempt = 0;
                let data = loop {
                    let pooled = match self.checkout_sftp() {
                        Ok(p) => p,
                        Err(e) => {
                            (self.error_reporter)(&e);
                            return Err(E_FAIL.into());
                        }
                    };
                    let read_res = (|| -> Result<Vec<u8>> {
                        let mut remote = pooled
                            .sftp
                            .open(Path::new(&entry.remote_path))
                            .map_err(err)?;
                        let mut data = Vec::with_capacity(entry.size as usize);
                        let mut buf = [0u8; STREAM_CHUNK_BYTES];
                        loop {
                            if self.cancel.load(Ordering::Relaxed) {
                                return Err("External drag cancelled.".into());
                            }
                            let n = remote.read(&mut buf).map_err(err)?;
                            if n == 0 {
                                break;
                            }
                            data.extend_from_slice(&buf[..n]);
                        }
                        Ok(data)
                    })();
                    match read_res {
                        Ok(data) => {
                            self.checkin_sftp(pooled);
                            break data;
                        }
                        Err(e) => {
                            if attempt == 0 && !self.cancel.load(Ordering::Relaxed) {
                                attempt += 1;
                                continue;
                            }
                            (self.error_reporter)(&e);
                            return Err(if self.cancel.load(Ordering::Relaxed) {
                                E_ABORT.into()
                            } else {
                                E_FAIL.into()
                            });
                        }
                    }
                };
                MemStream {
                    data: Arc::new(data),
                    pos: Mutex::new(0),
                }
                .into()
            } else {
                let (tx, rx) = mpsc::sync_channel::<std::result::Result<Vec<u8>, String>>(
                    STREAM_CHANNEL_CHUNKS,
                );
                let pool = self.sftp_pool.clone();
                let ctx = self.ctx.clone();
                let cancel = self.cancel.clone();
                let remote_path = entry.remote_path.clone();
                thread::spawn(move || {
                    let stream_res = (|| -> Result<()> {
                        let pooled = if let Some(p) = pool.lock().unwrap().pop() {
                            p
                        } else {
                            let session = authenticate(&ctx)?;
                            let sftp = session.sftp().map_err(err)?;
                            PooledSftp {
                                sftp,
                                _session: session,
                            }
                        };
                        let mut remote = match pooled.sftp.open(Path::new(&remote_path)) {
                            Ok(f) => f,
                            Err(_) => {
                                // Reconnect once if pooled connection became stale.
                                let session = authenticate(&ctx)?;
                                let sftp = session.sftp().map_err(err)?;
                                let fresh = PooledSftp {
                                    sftp,
                                    _session: session,
                                };
                                let mut f =
                                    fresh.sftp.open(Path::new(&remote_path)).map_err(err)?;
                                let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
                                loop {
                                    if cancel.load(Ordering::Relaxed) {
                                        return Ok(());
                                    }
                                    let n = f.read(&mut buf).map_err(err)?;
                                    if n == 0 {
                                        let _ = tx.send(Ok(Vec::new()));
                                        break;
                                    }
                                    if tx.send(Ok(buf[..n].to_vec())).is_err() {
                                        break;
                                    }
                                }
                                drop(f);
                                let mut guard = pool.lock().unwrap();
                                if guard.len() < 4 {
                                    guard.push(fresh);
                                }
                                return Ok(());
                            }
                        };
                        let mut buf = vec![0u8; STREAM_CHUNK_BYTES];
                        loop {
                            if cancel.load(Ordering::Relaxed) {
                                return Ok(());
                            }
                            let n = remote.read(&mut buf).map_err(err)?;
                            if n == 0 {
                                let _ = tx.send(Ok(Vec::new()));
                                break;
                            }
                            if tx.send(Ok(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        drop(remote);
                        let mut guard = pool.lock().unwrap();
                        if guard.len() < 4 {
                            guard.push(pooled);
                        }
                        Ok(())
                    })();
                    if let Err(e) = stream_res {
                        let _ = tx.send(Err(e));
                    }
                });
                StreamingSftpStream {
                    size: entry.size,
                    state: Mutex::new(StreamReaderState {
                        rx,
                        current: Vec::new(),
                        offset: 0,
                        eof: false,
                        pos: 0,
                    }),
                    cancel: self.cancel.clone(),
                    error_reporter: self.error_reporter.clone(),
                }
                .into()
            };

            Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 {
                    pstm: core::mem::ManuallyDrop::new(Some(stream)),
                },
                pUnkForRelease: core::mem::ManuallyDrop::new(None),
            })
        }

        fn find_stored_medium(&self, fmt: &FORMATETC) -> Option<STGMEDIUM> {
            let guard = self.stored_media.lock().unwrap();
            let item = guard.iter().find(|s| {
                s.fmt.cfFormat == fmt.cfFormat
                    && s.fmt.dwAspect == fmt.dwAspect
                    && (s.fmt.lindex == fmt.lindex || fmt.lindex == -1 || s.fmt.lindex == -1)
                    && (s.fmt.tymed & fmt.tymed) != 0
            })?;
            if (item.med.tymed & TYMED_HGLOBAL.0 as u32) != 0 {
                let src = unsafe { item.med.u.hGlobal };
                if src.0.is_null() {
                    return None;
                }
                let size = unsafe { GlobalSize(src) };
                let dst = unsafe { GlobalAlloc(GMEM_MOVEABLE, size) }.ok()?;
                let src_ptr = unsafe { GlobalLock(src) } as *const u8;
                let dst_ptr = unsafe { GlobalLock(dst) } as *mut u8;
                if !src_ptr.is_null() && !dst_ptr.is_null() {
                    unsafe { std::ptr::copy_nonoverlapping(src_ptr, dst_ptr, size) };
                }
                unsafe {
                    let _ = GlobalUnlock(src);
                    let _ = GlobalUnlock(dst);
                }
                return Some(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: dst },
                    pUnkForRelease: core::mem::ManuallyDrop::new(None),
                });
            }
            None
        }

        fn has_stored_medium(&self, fmt: &FORMATETC) -> bool {
            self.stored_media.lock().unwrap().iter().any(|s| {
                s.fmt.cfFormat == fmt.cfFormat
                    && s.fmt.dwAspect == fmt.dwAspect
                    && (s.fmt.tymed & fmt.tymed) != 0
            })
        }
    }

    impl IDataObjectAsyncCapability_Impl for RemoteDataObject_Impl {
        fn SetAsyncMode(&self, fdoopasync: BOOL) -> windows_core::Result<()> {
            self.async_mode
                .store(fdoopasync.as_bool(), Ordering::SeqCst);
            Ok(())
        }

        fn GetAsyncMode(&self) -> windows_core::Result<BOOL> {
            Ok(BOOL::from(self.async_mode.load(Ordering::SeqCst)))
        }

        fn StartOperation(&self, _: Ref<IBindCtx>) -> windows_core::Result<()> {
            self.drop_signaled.store(true, Ordering::SeqCst);
            self.in_operation.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn InOperation(&self) -> windows_core::Result<BOOL> {
            Ok(BOOL::from(self.in_operation.load(Ordering::SeqCst)))
        }

        fn EndOperation(
            &self,
            hresult: HRESULT,
            _: Ref<IBindCtx>,
            _: u32,
        ) -> windows_core::Result<()> {
            self.in_operation.store(false, Ordering::SeqCst);
            if hresult.is_err() {
                self.cancel.store(true, Ordering::Relaxed);
            }
            Ok(())
        }
    }

    impl IDataObject_Impl for RemoteDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
            let fmt = unsafe { pformatetcin.as_ref() }
                .ok_or_else(|| windows_core::Error::from(E_INVALIDARG))?;
            if self.matches_descriptor(fmt) {
                return self.build_descriptor_medium();
            }
            if self.matches_contents(fmt, false) {
                return self.build_contents_stream(fmt.lindex as usize);
            }
            if let Some(med) = self.find_stored_medium(fmt) {
                return Ok(med);
            }
            Err(DV_E_FORMATETC.into())
        }

        fn GetDataHere(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *mut STGMEDIUM,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            let Some(fmt) = (unsafe { pformatetc.as_ref() }) else {
                return E_INVALIDARG;
            };
            if self.matches_descriptor(fmt)
                || self.matches_contents(fmt, true)
                || self.has_stored_medium(fmt)
            {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }

        fn GetCanonicalFormatEtc(
            &self,
            pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            if !pformatetcout.is_null() {
                unsafe {
                    if let Some(input) = pformatectin.as_ref() {
                        *pformatetcout = *input;
                    }
                    (*pformatetcout).ptd = std::ptr::null_mut();
                }
            }
            windows::Win32::Foundation::DATA_S_SAMEFORMATETC
        }

        fn SetData(
            &self,
            pformatetc: *const FORMATETC,
            pmedium: *const STGMEDIUM,
            frelease: BOOL,
        ) -> windows_core::Result<()> {
            let fmt = unsafe { pformatetc.as_ref() }
                .ok_or_else(|| windows_core::Error::from(E_INVALIDARG))?;
            let med = unsafe { pmedium.as_ref() }
                .ok_or_else(|| windows_core::Error::from(E_INVALIDARG))?;
            if fmt.cfFormat == self.cf_target_clsid {
                self.drop_signaled.store(true, Ordering::SeqCst);
            }
            if !frelease.as_bool() {
                return Err(E_NOTIMPL.into());
            }
            let owned = unsafe { std::ptr::read(med) };
            let mut guard = self.stored_media.lock().unwrap();
            guard.retain(|item| {
                !(item.fmt.cfFormat == fmt.cfFormat
                    && item.fmt.dwAspect == fmt.dwAspect
                    && item.fmt.lindex == fmt.lindex)
            });
            guard.push(StoredMedium {
                fmt: *fmt,
                med: owned,
            });
            Ok(())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows_core::Result<IEnumFORMATETC> {
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            let formats = self.format_list();
            unsafe { SHCreateStdEnumFmtEtc(&formats) }
        }

        fn DAdvise(
            &self,
            _pformatetc: *const FORMATETC,
            _advf: u32,
            _padvsink: Ref<IAdviseSink>,
        ) -> windows_core::Result<u32> {
            Err(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn DUnadvise(&self, _dwconnection: u32) -> windows_core::Result<()> {
            Err(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn EnumDAdvise(&self) -> windows_core::Result<IEnumSTATDATA> {
            Err(windows::Win32::Foundation::OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    struct MtaDataObjectHandle {
        raw_stream: usize,
        drop_signaled: Arc<AtomicBool>,
        #[cfg(test)]
        done_signal: Arc<(Mutex<bool>, Condvar)>,
    }

    /// Consumes a raw COM marshal `IStream` pointer via `CoGetInterfaceAndReleaseStream`
    /// without double-releasing the stream when Win32 releases it on return.
    unsafe fn unmarshal_data_object(raw_stream: usize, context: &str) -> Result<IDataObject> {
        // CoGetInterfaceAndReleaseStream always releases `pstm` internally, so keep
        // Rust from running a second COM Release() on the wrapped pointer.
        let marshal_stream = core::mem::ManuallyDrop::new(unsafe {
            IStream::from_raw(raw_stream as *mut core::ffi::c_void)
        });
        unsafe { CoGetInterfaceAndReleaseStream(&*marshal_stream) }
            .map_err(|e| format!("{context}: {e}"))
    }

    /// Releases a serialized COM marshal stream that was never handed to
    /// `CoGetInterfaceAndReleaseStream`.
    unsafe fn release_marshal_stream(raw_stream: usize) {
        let stream = unsafe { IStream::from_raw(raw_stream as *mut core::ffi::c_void) };
        let _ = unsafe { CoReleaseMarshalData(&stream) };
    }

    fn spawn_mta_data_object(
        root_entries: Vec<DragEntry>,
        ctx: Arc<Context>,
        error_reporter: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<MtaDataObjectHandle> {
        let cf_descriptor = unsafe { RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) } as u16;
        let cf_contents = unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16;
        let cf_target_clsid = unsafe { RegisterClipboardFormatW(CFSTR_TARGETCLSID) } as u16;
        if cf_descriptor == 0 || cf_contents == 0 {
            return Err("Failed to register Shell clipboard formats.".into());
        }

        let drop_signaled = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let done_signal = Arc::new((Mutex::new(false), Condvar::new()));

        // Host RemoteDataObject in an MTA thread so Explorer's async background
        // COM calls run on the MTA RPC thread pool instead of blocking the UI STA thread.
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<usize>>(1);
        let mta_drop_signaled = drop_signaled.clone();
        let mta_done_signal = done_signal.clone();
        let mta_cancel = cancel.clone();
        thread::spawn(move || {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_err() {
                let _ = ready_tx.send(Err(format!("COM MTA initialization failed: {hr:?}")));
                return;
            }
            let _com = ComMtaGuard;
            let data_obj: IDataObject = RemoteDataObject {
                root_entries,
                full_entries: Mutex::new(None),
                ctx,
                sftp_pool: Arc::new(Mutex::new(Vec::new())),
                cf_descriptor,
                cf_contents,
                cf_target_clsid,
                async_mode: AtomicBool::new(true),
                in_operation: AtomicBool::new(false),
                drop_signaled: mta_drop_signaled,
                cancel: mta_cancel,
                stored_media: Mutex::new(Vec::new()),
                done_signal: mta_done_signal.clone(),
                error_reporter,
            }
            .into();

            let stream = match unsafe {
                CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, &data_obj)
            } {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("COM drag marshaling failed: {e}")));
                    return;
                }
            };
            let raw_stream = stream.into_raw() as usize;
            if ready_tx.send(Ok(raw_stream)).is_err() {
                unsafe { release_marshal_stream(raw_stream) };
                return;
            }
            drop(data_obj);

            let (lock, cvar) = &*mta_done_signal;
            let mut done = lock.lock().unwrap();
            while !*done {
                done = cvar.wait(done).unwrap();
            }
        });

        let raw_stream = ready_rx.recv().map_err(err)??;
        Ok(MtaDataObjectHandle {
            raw_stream,
            drop_signaled,
            #[cfg(test)]
            done_signal,
        })
    }

    pub fn run_ole_drag(
        app: AppHandle,
        root_entries: Vec<DragEntry>,
        ctx: Arc<Context>,
    ) -> Result<bool> {
        let error_app = app.clone();
        let error_sent = Arc::new(AtomicBool::new(false));
        let error_reporter: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |msg: &str| {
            if !error_sent.swap(true, Ordering::SeqCst) {
                let _ = error_app.emit("external-drag-error", msg.to_string());
            }
        });

        let handle = spawn_mta_data_object(root_entries, ctx, error_reporter)?;
        let raw_stream = handle.raw_stream;
        let drop_signaled = handle.drop_signaled;

        let (tx, rx) = mpsc::sync_channel(1);
        let dispatch = app.run_on_main_thread(move || {
            let outcome = (|| -> Result<bool> {
                let hr = unsafe { OleInitialize(None) };
                if hr.is_err() {
                    unsafe { release_marshal_stream(raw_stream) };
                    return Err(format!("OLE initialization failed: {hr:?}"));
                }
                let _ole = OleGuard;
                let data_obj =
                    unsafe { unmarshal_data_object(raw_stream, "COM drag unmarshaling failed") }?;
                let drop_src: IDropSource = RemoteDropSource { drop_signaled }.into();
                unsafe {
                    let _ = ReleaseCapture();
                }
                let effect = unsafe { SHDoDragDrop(None, &data_obj, &drop_src, DROPEFFECT_COPY) };
                match effect {
                    Ok(eff) => Ok(eff.0 != 0),
                    Err(e) => Err(format!("External drag failed: {e}")),
                }
            })();
            let _ = tx.send(outcome);
        });
        if let Err(e) = dispatch {
            unsafe { release_marshal_stream(raw_stream) };
            return Err(err(e));
        }
        rx.recv().map_err(err)?
    }

    #[cfg(test)]
    pub(crate) fn test_mta_drop_to_dir(
        ctx: Arc<Context>,
        remote_root: &str,
        dest_dir: &Path,
    ) -> Result<()> {
        use windows::Win32::System::Ole::IDropTarget;
        use windows::Win32::UI::Shell::{BHID_SFUIObject, IShellItem, SHCreateItemFromParsingName};
        use windows_core::PCWSTR;

        let root_name = crate::files::remote_item_name(remote_root)?.to_owned();
        let root_entries = vec![DragEntry {
            remote_path: remote_root.to_string(),
            relative_windows_path: root_name,
            directory: true,
            size: 0,
        }];
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let err_clone = errors.clone();
        let reporter: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |msg: &str| {
            err_clone.lock().unwrap().push(msg.to_string());
        });
        let handle = spawn_mta_data_object(root_entries, ctx, reporter)?;
        let hr = unsafe { OleInitialize(None) };
        if hr.is_err() {
            unsafe { release_marshal_stream(handle.raw_stream) };
            return Err(format!("OLE initialization failed: {hr:?}"));
        }
        let _ole = OleGuard;
        let data_obj = unsafe { unmarshal_data_object(handle.raw_stream, "Unmarshal failed") }?;

        let wide: Vec<u16> = dest_dir
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let item: IShellItem =
            unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }.map_err(err)?;
        let target: IDropTarget =
            unsafe { item.BindToHandler(None, &BHID_SFUIObject) }.map_err(err)?;

        let enter_started = std::time::Instant::now();
        let mut eff = DROPEFFECT_COPY;
        unsafe {
            target.DragEnter(
                &data_obj,
                MODIFIERKEYS_FLAGS(1),
                POINTL { x: 10, y: 10 },
                &mut eff,
            )
        }
        .map_err(err)?;
        assert!(
            enter_started.elapsed() < std::time::Duration::from_secs(2),
            "DragEnter must not scan SFTP tree synchronously"
        );
        assert_ne!(eff.0, 0);

        handle.drop_signaled.store(true, Ordering::SeqCst);
        let mut eff2 = DROPEFFECT_COPY;
        unsafe {
            target.Drop(
                &data_obj,
                MODIFIERKEYS_FLAGS(0),
                POINTL { x: 10, y: 10 },
                &mut eff2,
            )
        }
        .map_err(err)?;
        drop(data_obj);

        let (lock, cvar) = &*handle.done_signal;
        let mut done = lock.lock().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !*done {
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err("Timed out waiting for async Explorer drop to complete.".into());
            }
            let (guard, _) = cvar.wait_timeout(done, deadline - now).unwrap();
            done = guard;
        }
        let errs = errors.lock().unwrap();
        if !errs.is_empty() {
            return Err(format!("Async drop reported errors: {}", errs.join("; ")));
        }
        Ok(())
    }

    #[cfg(test)]
    #[test]
    fn mem_stream_supports_read_seek_stat_and_clone() {
        let stm: IStream = MemStream {
            data: Arc::new(b"Hello ShellDock".to_vec()),
            pos: Mutex::new(0),
        }
        .into();
        let mut stat = STATSTG::default();
        unsafe { stm.Stat(&mut stat, STATFLAG(1)) }.unwrap();
        assert_eq!(stat.cbSize, 15);
        assert_eq!(stat.r#type, STGTY_STREAM.0 as u32);
        let mut pos = 0u64;
        unsafe { stm.Seek(6, STREAM_SEEK(0), Some(&mut pos)) }.unwrap();
        assert_eq!(pos, 6);
        let cloned = unsafe { stm.Clone() }.unwrap();
        let mut buf = [0u8; 9];
        let mut read = 0u32;
        let hr = unsafe { cloned.Read(buf.as_mut_ptr() as *mut _, 9, Some(&mut read)) };
        assert_eq!(hr, S_OK);
        assert_eq!(read, 9);
        assert_eq!(&buf, b"ShellDock");
    }
}

#[cfg(all(test, windows))]
pub(crate) use win_drag::test_mta_drop_to_dir;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_root_entries_validates_and_preserves_hints() {
        let hints = vec![DragRootHint {
            path: "/srv/skyblock".into(),
            directory: true,
            size: 0,
        }];
        let entries = build_root_entries(
            vec!["/srv/skyblock".into(), "/srv/eula.txt".into()],
            Some(&hints),
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].relative_windows_path, "skyblock");
        assert!(entries[0].directory);
        assert_eq!(entries[1].relative_windows_path, "eula.txt");
        assert!(build_root_entries(vec!["/a/same".into(), "/b/same".into()], None).is_err());
        assert!(build_root_entries(vec!["/".into()], None).is_err());
    }
}
