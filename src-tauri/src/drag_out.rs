use crate::{authenticate, blocking, context, err, sftp::PooledSftp, Backend, Context, Result};
use serde::Serialize;
use ssh2::Sftp;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
};
use tauri::{AppHandle, State};

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
struct DragEntry {
    remote_path: String,
    relative_windows_path: String,
    directory: bool,
    size: u64,
}

fn collect_drag_entry(
    sftp: &Sftp,
    remote: &str,
    relative: String,
    items: &mut Vec<DragEntry>,
    depth: usize,
) -> Result<()> {
    if depth > 64 || items.len() >= 2_000 {
        return Err(
            "External drag is limited to 2,000 items. Use Download for larger trees.".into(),
        );
    }
    if relative.encode_utf16().count() >= 259 {
        return Err("A dragged path exceeds Windows filename limits.".into());
    }
    let stat = sftp.lstat(Path::new(remote)).map_err(err)?;
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
        for (path, _) in children {
            let Some(filename) = path.file_name().and_then(|v| v.to_str()) else {
                continue;
            };
            if matches!(filename, "." | "..") {
                continue;
            }
            crate::files::download_name(filename)?;
            let next_remote = format!("{}/{}", remote.trim_end_matches('/'), filename);
            let next_relative = format!("{relative}\\{filename}");
            collect_drag_entry(sftp, &next_remote, next_relative, items, depth + 1)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_external_drag(
    app: AppHandle,
    state: State<'_, Backend>,
    id: String,
    paths: Vec<String>,
) -> Result<bool> {
    if paths.is_empty() {
        return Ok(false);
    }
    let ctx = context(&state, &id)?;
    let entries = blocking(move || {
        let session = authenticate(&ctx)?;
        let sftp = session.sftp().map_err(err)?;
        let mut entries = Vec::new();
        let mut seen_roots = std::collections::HashSet::new();
        for source in paths {
            let root_name = crate::files::remote_item_name(&source)?;
            crate::files::download_name(root_name)?;
            if !seen_roots.insert(root_name.to_owned()) {
                return Err("Selected roots have duplicate names.".into());
            }
            collect_drag_entry(&sftp, &source, root_name.to_owned(), &mut entries, 0)?;
        }
        Ok((entries, ctx))
    })
    .await?;

    let (entries, ctx) = entries;
    if entries.is_empty() {
        return Ok(false);
    }

    #[cfg(windows)]
    {
        let (tx, rx) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let outcome = run_ole_drag(entries, ctx);
            let _ = tx.send(outcome);
        })
        .map_err(err)?;
        rx.recv().map_err(err)?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, entries, ctx);
        Ok(false)
    }
}

#[cfg(windows)]
fn run_ole_drag(entries: Vec<DragEntry>, ctx: Arc<Context>) -> Result<bool> {
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DV_E_FORMATETC, E_NOTIMPL, HGLOBAL, POINTL, SIZE, S_OK,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::System::Com::{
        IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
        IEnumSTATDATA, IStream, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0,
        STGM_READ, STGM_SHARE_DENY_WRITE, TYMED_HGLOBAL, TYMED_ISTREAM,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
        DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows::Win32::UI::Shell::{
        SHCreateStreamOnFileEx, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES,
        FD_FILESIZE, FILEDESCRIPTORW,
    };
    use windows_core::{implement, Ref, BOOL, HRESULT, PCWSTR};

    struct OleGuard;
    impl Drop for OleGuard {
        fn drop(&mut self) {
            unsafe { OleUninitialize() };
        }
    }

    let hr = unsafe { OleInitialize(None) };
    if hr.is_err() {
        return Err(format!("OLE initialization failed: {hr:?}"));
    }
    let _ole = OleGuard;

    let cf_descriptor = unsafe { RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) } as u16;
    let cf_contents = unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16;
    if cf_descriptor == 0 || cf_contents == 0 {
        return Err("Failed to register Shell clipboard formats.".into());
    }

    let temp_dir = std::env::temp_dir().join(format!("shelldock-drag-{}", uuid::Uuid::new_v4()));

    #[implement(IEnumFORMATETC)]
    struct FormatEnumerator {
        formats: Vec<FORMATETC>,
        cursor: Mutex<usize>,
    }

    impl IEnumFORMATETC_Impl for FormatEnumerator_Impl {
        fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
            if rgelt.is_null() {
                return windows::Win32::Foundation::E_INVALIDARG;
            }
            let mut cursor = self.cursor.lock().unwrap();
            let mut fetched = 0u32;
            while fetched < celt && *cursor < self.formats.len() {
                unsafe {
                    *rgelt.add(fetched as usize) = self.formats[*cursor];
                }
                *cursor += 1;
                fetched += 1;
            }
            if !pceltfetched.is_null() {
                unsafe { *pceltfetched = fetched };
            }
            if fetched == celt {
                S_OK
            } else {
                windows::Win32::Foundation::S_FALSE
            }
        }

        fn Skip(&self, celt: u32) -> windows_core::Result<()> {
            let mut cursor = self.cursor.lock().unwrap();
            *cursor = (*cursor + celt as usize).min(self.formats.len());
            if *cursor < self.formats.len() {
                Ok(())
            } else {
                Err(windows::Win32::Foundation::S_FALSE.into())
            }
        }

        fn Reset(&self) -> windows_core::Result<()> {
            *self.cursor.lock().unwrap() = 0;
            Ok(())
        }

        fn Clone(&self) -> windows_core::Result<IEnumFORMATETC> {
            let cursor = *self.cursor.lock().unwrap();
            Ok(FormatEnumerator {
                formats: self.formats.clone(),
                cursor: Mutex::new(cursor),
            }
            .into())
        }
    }

    #[implement(IDropSource)]
    struct RemoteDropSource;

    impl IDropSource_Impl for RemoteDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if fescapepressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if (grfkeystate.0 & MK_LBUTTON.0) == 0 {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            windows::Win32::Foundation::DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    #[implement(IDataObject)]
    struct RemoteDataObject {
        entries: Vec<DragEntry>,
        ctx: Arc<Context>,
        sftp_cache: Mutex<Option<PooledSftp>>,
        temp_dir: PathBuf,
        cf_descriptor: u16,
        cf_contents: u16,
    }

    impl Drop for RemoteDataObject {
        fn drop(&mut self) {
            if self.temp_dir.exists() {
                let _ = fs::remove_dir_all(&self.temp_dir);
            }
        }
    }

    impl RemoteDataObject {
        fn format_list(&self) -> Vec<FORMATETC> {
            vec![
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
            ]
        }

        fn matches_descriptor(&self, fmt: &FORMATETC) -> bool {
            fmt.cfFormat == self.cf_descriptor
                && (fmt.tymed & (TYMED_HGLOBAL.0 as u32)) != 0
                && fmt.dwAspect == DVASPECT_CONTENT.0
        }

        fn matches_contents(&self, fmt: &FORMATETC, allow_wildcard_index: bool) -> bool {
            let valid_index = (fmt.lindex >= 0 && (fmt.lindex as usize) < self.entries.len())
                || (allow_wildcard_index && fmt.lindex == -1);
            fmt.cfFormat == self.cf_contents
                && (fmt.tymed & (TYMED_ISTREAM.0 as u32)) != 0
                && fmt.dwAspect == DVASPECT_CONTENT.0
                && valid_index
        }

        fn build_descriptor_medium(&self) -> windows_core::Result<STGMEDIUM> {
            let item_size = std::mem::size_of::<FILEDESCRIPTORW>();
            let total_bytes = 4 + self.entries.len() * item_size;
            let hglobal: HGLOBAL =
                unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes) }?;
            let ptr = unsafe { GlobalLock(hglobal) } as *mut u8;
            if ptr.is_null() {
                return Err(windows::Win32::Foundation::E_OUTOFMEMORY.into());
            }
            unsafe {
                std::ptr::write_unaligned(ptr as *mut u32, self.entries.len() as u32);
                for (index, entry) in self.entries.iter().enumerate() {
                    let mut wide_name = [0u16; 260];
                    for (slot, unit) in wide_name
                        .iter_mut()
                        .zip(entry.relative_windows_path.encode_utf16())
                    {
                        *slot = unit;
                    }
                    let desc = FILEDESCRIPTORW {
                        dwFlags: if entry.directory {
                            FD_ATTRIBUTES.0 as u32
                        } else {
                            (FD_ATTRIBUTES.0 | FD_FILESIZE.0) as u32
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
            let entry = self
                .entries
                .get(index)
                .ok_or_else(|| windows_core::Error::from(DV_E_FORMATETC))?;
            if entry.directory {
                return Err(DV_E_FORMATETC.into());
            }
            fs::create_dir_all(&self.temp_dir)
                .map_err(|_| windows_core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            let local_file = self.temp_dir.join(format!("item-{index}.bin"));
            {
                let mut cache = self.sftp_cache.lock().unwrap();
                if cache.is_none() {
                    let session = authenticate(&self.ctx).map_err(|_| {
                        windows_core::Error::from(windows::Win32::Foundation::E_FAIL)
                    })?;
                    let sftp = session.sftp().map_err(|_| {
                        windows_core::Error::from(windows::Win32::Foundation::E_FAIL)
                    })?;
                    *cache = Some(PooledSftp {
                        sftp,
                        _session: session,
                    });
                }
                let pooled = cache.as_ref().unwrap();
                let mut remote = pooled
                    .sftp
                    .open(Path::new(&entry.remote_path))
                    .map_err(|_| windows_core::Error::from(windows::Win32::Foundation::E_FAIL))?;
                let mut target = fs::File::create(&local_file)
                    .map_err(|_| windows_core::Error::from(windows::Win32::Foundation::E_FAIL))?;
                let mut buffer = [0u8; 65536];
                loop {
                    let n = remote.read(&mut buffer).map_err(|_| {
                        windows_core::Error::from(windows::Win32::Foundation::E_FAIL)
                    })?;
                    if n == 0 {
                        break;
                    }
                    target.write_all(&buffer[..n]).map_err(|_| {
                        windows_core::Error::from(windows::Win32::Foundation::E_FAIL)
                    })?;
                }
                target
                    .flush()
                    .map_err(|_| windows_core::Error::from(windows::Win32::Foundation::E_FAIL))?;
            }
            let wide: Vec<u16> = local_file
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let stream: IStream = unsafe {
                SHCreateStreamOnFileEx(
                    PCWSTR(wide.as_ptr()),
                    (STGM_READ | STGM_SHARE_DENY_WRITE).0,
                    FILE_ATTRIBUTE_NORMAL.0,
                    false,
                    None,
                )
            }?;
            Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 {
                    pstm: core::mem::ManuallyDrop::new(Some(stream)),
                },
                pUnkForRelease: core::mem::ManuallyDrop::new(None),
            })
        }
    }

    impl IDataObject_Impl for RemoteDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
            let fmt = unsafe { pformatetcin.as_ref() }.ok_or_else(|| {
                windows_core::Error::from(windows::Win32::Foundation::E_INVALIDARG)
            })?;
            if self.matches_descriptor(fmt) {
                return self.build_descriptor_medium();
            }
            if self.matches_contents(fmt, false) {
                return self.build_contents_stream(fmt.lindex as usize);
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
                return windows::Win32::Foundation::E_INVALIDARG;
            };
            if self.matches_descriptor(fmt) || self.matches_contents(fmt, true) {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }

        fn GetCanonicalFormatEtc(
            &self,
            _pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            if !pformatetcout.is_null() {
                unsafe {
                    (*pformatetcout).ptd = std::ptr::null_mut();
                }
            }
            windows::Win32::Foundation::DATA_S_SAMEFORMATETC
        }

        fn SetData(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *const STGMEDIUM,
            _frelease: BOOL,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows_core::Result<IEnumFORMATETC> {
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            Ok(FormatEnumerator {
                formats: self.format_list(),
                cursor: Mutex::new(0),
            }
            .into())
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

    let data_obj: IDataObject = RemoteDataObject {
        entries,
        ctx,
        sftp_cache: Mutex::new(None),
        temp_dir,
        cf_descriptor,
        cf_contents,
    }
    .into();
    let drop_src: IDropSource = RemoteDropSource.into();

    unsafe {
        let _ = ReleaseCapture();
    }
    let mut effect = DROPEFFECT(0);
    let result = unsafe { DoDragDrop(&data_obj, &drop_src, DROPEFFECT_COPY, &mut effect) };
    Ok(result == DRAGDROP_S_DROP)
}
