//! Thin bridge between the web UI and `orga-core`.
//! Everything the user sees lives in TypeScript; this file only exposes
//! file access and encryption as commands.
//!
//! No command accepts a file path from the web UI. Paths come only from file
//! dialogs opened here in Rust, or from files the user dropped onto the window,
//! so a script in the webview cannot read or write arbitrary files.

use std::path::PathBuf;
use std::sync::Mutex;

use orga_core::{Codes, Store};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

/// Largest document the app accepts (bytes).
const MAX_DOC_SIZE: u64 = 50 * 1024 * 1024;

// Commands marked `async` run on a worker thread, so slow steps (key
// derivation, large files) do not freeze the window.
struct AppState(Mutex<Store>);

/// Files dropped onto the window, waiting for the UI to ask for them.
struct Dropped(Mutex<Vec<PathBuf>>);

/// Where the data folder came from.
#[derive(Clone, Copy, PartialEq)]
enum DirSource {
    /// ORGA_NEO_DIR is set; the setting cannot change it.
    Env,
    /// Picked in the settings and remembered in the app's config file.
    Chosen,
    Default,
}

struct DataDirs {
    source: Mutex<DirSource>,
    /// Folder picked in the settings, waiting for `data_dir_apply`.
    pending: Mutex<Option<PathBuf>>,
}

/// Small file in the app's config folder (not in the data folder) that
/// remembers a data folder chosen in the settings.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<PathBuf>,
}

type CmdResult<T> = Result<T, String>;

fn e(err: orga_core::Error) -> String {
    err.to_string()
}

fn io(err: std::io::Error) -> String {
    format!("io: {err}")
}

/// A file dialog in front of the app window.
fn dialog(window: &Window, title: &str) -> FileDialogBuilder<tauri::Wry> {
    window.dialog().file().set_parent(window).set_title(title)
}

/// Fail before showing a dialog, rather than after the user picked something.
fn need_unlocked(state: &State<AppState>) -> CmdResult<()> {
    if state.0.lock().unwrap().is_unlocked() { Ok(()) } else { Err("locked".into()) }
}

fn extension(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, x)| x).filter(|x| !x.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    initialized: bool,
    unlocked: bool,
    data_dir: String,
    /// Set by ORGA_NEO_DIR, so the setting cannot change it.
    data_dir_fixed: bool,
    /// The chosen folder is not reachable (e.g. a USB stick is not plugged in).
    data_dir_missing: bool,
    log_dir: String,
}

#[derive(Serialize)]
struct AddedDoc {
    id: String,
    name: String,
    size: u64,
}

#[tauri::command]
fn status(app: AppHandle, state: State<AppState>, dirs: State<DataDirs>) -> Status {
    let s = state.0.lock().unwrap();
    let source = *dirs.source.lock().unwrap();
    Status {
        initialized: s.is_initialized(),
        unlocked: s.is_unlocked(),
        data_dir: s.dir().display().to_string(),
        data_dir_fixed: source == DirSource::Env,
        data_dir_missing: source == DirSource::Chosen && !s.dir().is_dir(),
        log_dir: app.path().app_log_dir().map(|d| d.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
fn load_open(state: State<AppState>) -> CmdResult<String> {
    state.0.lock().unwrap().read_open().map_err(e)
}

#[tauri::command]
fn save_open(state: State<AppState>, json: String) -> CmdResult<()> {
    state.0.lock().unwrap().write_open(&json).map_err(e)
}

#[tauri::command(async)]
fn vault_create(state: State<AppState>, password: String) -> CmdResult<Codes> {
    state.0.lock().unwrap().create_vault(&password).map_err(e)
}

#[tauri::command(async)]
fn vault_unlock(state: State<AppState>, password: String) -> CmdResult<()> {
    state.0.lock().unwrap().unlock(&password).map_err(e)
}

#[tauri::command(async)]
fn vault_unlock_code(state: State<AppState>, code: String) -> CmdResult<()> {
    state.0.lock().unwrap().unlock_with_code(&code).map_err(e)
}

#[tauri::command]
fn vault_lock(state: State<AppState>) {
    state.0.lock().unwrap().lock();
}

#[tauri::command]
fn vault_load(state: State<AppState>) -> CmdResult<String> {
    state.0.lock().unwrap().read_vault().map_err(e)
}

#[tauri::command]
fn vault_save(state: State<AppState>, json: String) -> CmdResult<()> {
    state.0.lock().unwrap().write_vault(&json).map_err(e)
}

#[tauri::command(async)]
fn vault_change_password(state: State<AppState>, password: String) -> CmdResult<()> {
    state.0.lock().unwrap().change_password(&password).map_err(e)
}

#[tauri::command(async)]
fn vault_new_codes(state: State<AppState>) -> CmdResult<Codes> {
    state.0.lock().unwrap().new_codes().map_err(e)
}

/// Encrypt the files at `paths` into the vault. Returns one entry per stored file.
fn add_docs(state: &State<AppState>, paths: Vec<PathBuf>) -> CmdResult<Vec<AddedDoc>> {
    let store = state.0.lock().unwrap();
    let mut added = Vec::new();
    for path in paths {
        let meta = std::fs::metadata(&path).map_err(io)?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_DOC_SIZE {
            return Err("too_large".into());
        }
        let bytes = std::fs::read(&path).map_err(io)?;
        let id = new_id();
        store.add_doc(&id, &bytes).map_err(e)?;
        added.push(AddedDoc {
            id,
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            size: meta.len(),
        });
    }
    Ok(added)
}

/// Let the user pick files and store them encrypted. Cancelling adds nothing.
#[tauri::command(async)]
fn doc_pick_and_add(window: Window, state: State<AppState>) -> CmdResult<Vec<AddedDoc>> {
    need_unlocked(&state)?;
    let Some(picked) = dialog(&window, "Dokumente auswählen").blocking_pick_files() else {
        return Ok(Vec::new());
    };
    let paths = picked.into_iter().filter_map(|p| p.into_path().ok()).collect();
    add_docs(&state, paths)
}

/// Store the files most recently dropped onto the window.
#[tauri::command(async)]
fn doc_add_dropped(state: State<AppState>, dropped: State<Dropped>) -> CmdResult<Vec<AddedDoc>> {
    let paths = std::mem::take(&mut *dropped.0.lock().unwrap());
    add_docs(&state, paths)
}

#[tauri::command(async)]
fn doc_read(state: State<AppState>, id: String) -> CmdResult<Response> {
    let bytes = state.0.lock().unwrap().read_doc(&id).map_err(e)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn doc_delete(state: State<AppState>, id: String) -> CmdResult<()> {
    state.0.lock().unwrap().delete_doc(&id).map_err(e)
}

/// Ask where to save, offering `file_name`. None when the user cancels.
fn pick_save_path(window: &Window, file_name: &str) -> Option<PathBuf> {
    let name = safe_component(file_name);
    let mut d = dialog(window, "Speichern unter").set_file_name(&name);
    if let Some(ext) = extension(&name) {
        d = d.add_filter(ext.to_uppercase(), &[ext]);
    }
    d.blocking_save_file()?.into_path().ok()
}

/// Save a decrypted copy of a document where the user chooses. Resolves false on cancel.
#[tauri::command(async)]
fn doc_export(window: Window, state: State<AppState>, id: String, file_name: String) -> CmdResult<bool> {
    need_unlocked(&state)?;
    let Some(path) = pick_save_path(&window, &file_name) else { return Ok(false) };
    let bytes = state.0.lock().unwrap().read_doc(&id).map_err(e)?;
    std::fs::write(path, bytes).map_err(io)?;
    Ok(true)
}

#[derive(serde::Deserialize)]
struct ExportItem {
    id: String,
    /// Folder names from the app, outermost first.
    folders: Vec<String>,
    file: String,
}

/// Make a name safe to use as one path component on Windows and Linux.
fn safe_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() { "_".into() } else { cleaned }
}

/// Write readable copies of documents into a folder the user picks, in real
/// folders that mirror the folders shown in the app. Existing files are never
/// overwritten. Resolves the number written, or None on cancel.
#[tauri::command(async)]
fn doc_export_all(window: Window, state: State<AppState>, items: Vec<ExportItem>) -> CmdResult<Option<u32>> {
    need_unlocked(&state)?;
    let Some(dir) = dialog(&window, "Ordner für die Kopien auswählen")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let store = state.0.lock().unwrap();
    let mut count = 0;
    for item in items {
        let mut target = dir.clone();
        for f in &item.folders {
            target.push(safe_component(f));
        }
        std::fs::create_dir_all(&target).map_err(io)?;
        let file = safe_component(&item.file);
        let (stem, ext) = match file.rsplit_once('.') {
            Some((s, x)) if !s.is_empty() => (s.to_string(), format!(".{x}")),
            _ => (file.clone(), String::new()),
        };
        let mut path = target.join(&file);
        let mut n = 2;
        while path.exists() {
            path = target.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        let bytes = store.read_doc(&item.id).map_err(e)?;
        std::fs::write(&path, bytes).map_err(io)?;
        count += 1;
    }
    Ok(Some(count))
}

/// Save an export (calendar, addresses, …) where the user chooses. Resolves false on cancel.
#[tauri::command(async)]
fn save_text_file(window: Window, file_name: String, contents: String) -> CmdResult<bool> {
    let Some(path) = pick_save_path(&window, &file_name) else { return Ok(false) };
    std::fs::write(path, contents).map_err(io)?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedDir {
    /// For display only; the path itself stays here until `data_dir_apply`.
    path: String,
    has_data: bool,
}

/// Let the user pick a new data folder. If the picked folder holds no
/// Orga-Neo data, the data will go into an "Orga-Neo" folder inside it.
#[tauri::command(async)]
fn data_dir_pick(window: Window, state: State<AppState>, dirs: State<DataDirs>) -> CmdResult<Option<PickedDir>> {
    if *dirs.source.lock().unwrap() == DirSource::Env {
        return Err("dir_fixed".into());
    }
    let Some(picked) = dialog(&window, "Neuen Speicherort auswählen")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let target = if Store::has_data(&picked) || picked.file_name().is_some_and(|n| n == "Orga-Neo") {
        picked
    } else {
        picked.join("Orga-Neo")
    };
    state.0.lock().unwrap().check_new_dir(&target).map_err(e)?;
    let has_data = Store::has_data(&target);
    let path = target.display().to_string();
    *dirs.pending.lock().unwrap() = Some(target);
    Ok(Some(PickedDir { path, has_data }))
}

/// Switch to the folder from `data_dir_pick`. "move" takes the current data
/// along; "use" opens the data already in that folder (the vault locks).
#[tauri::command(async)]
fn data_dir_apply(app: AppHandle, state: State<AppState>, dirs: State<DataDirs>, mode: String) -> CmdResult<()> {
    let target = dirs.pending.lock().unwrap().take().ok_or("io: Bitte wählen Sie den Ordner noch einmal.")?;
    let mut store = state.0.lock().unwrap();
    let old = store.dir().display().to_string();
    let remember = || write_config(&app, &AppConfig { data_dir: Some(target.clone()) });
    match mode.as_str() {
        "move" => store.move_to(&target, remember).map_err(e)?,
        "use" if Store::has_data(&target) => {
            store.check_new_dir(&target).map_err(e)?;
            remember().map_err(io)?;
            *store = Store::new(target.clone());
        }
        _ => return Err("io: Ungültige Auswahl.".into()),
    }
    *dirs.source.lock().unwrap() = DirSource::Chosen;
    log::info!("data folder changed ({mode}): {old} -> {}", target.display());
    Ok(())
}

/// Go back to the standard folder (Documents/Orga-Neo), e.g. when the chosen
/// one is no longer reachable. Nothing is moved or deleted.
#[tauri::command]
fn data_dir_reset(app: AppHandle, state: State<AppState>, dirs: State<DataDirs>) -> CmdResult<()> {
    if *dirs.source.lock().unwrap() == DirSource::Env {
        return Err("dir_fixed".into());
    }
    write_config(&app, &AppConfig::default()).map_err(io)?;
    let dir = default_data_dir(&app);
    log::info!("data folder reset to {}", dir.display());
    *state.0.lock().unwrap() = Store::new(dir);
    *dirs.source.lock().unwrap() = DirSource::Default;
    Ok(())
}

fn config_path(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    Ok(dir.join("settings.json"))
}

fn read_config(app: &AppHandle) -> AppConfig {
    let raw = config_path(app).and_then(std::fs::read);
    raw.ok().and_then(|r| serde_json::from_slice(&r).ok()).unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &AppConfig) -> std::io::Result<()> {
    let path = config_path(app)?;
    std::fs::create_dir_all(path.parent().unwrap_or(&path))?;
    let json = serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)
}

fn new_id() -> String {
    let mut b = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The standard data folder: `Documents/Orga-Neo` (on many Windows PCs that
/// folder is synced by OneDrive).
fn default_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Orga-Neo")
}

/// ORGA_NEO_DIR wins, then the folder chosen in the settings, then the standard folder.
fn data_dir(app: &AppHandle) -> (PathBuf, DirSource) {
    if let Ok(dir) = std::env::var("ORGA_NEO_DIR") {
        return (PathBuf::from(dir), DirSource::Env);
    }
    match read_config(app).data_dir {
        Some(dir) => (dir, DirSource::Chosen),
        None => (default_data_dir(app), DirSource::Default),
    }
}

/// A log file in the app's log folder (on Windows
/// `%LOCALAPPDATA%\io.github.matthabjan.organeo\logs`), kept small. It is
/// meant for helping someone remotely: never log secrets, names or contents.
fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([
            Target::new(TargetKind::LogDir { file_name: Some("Orga-Neo".into()) }),
            Target::new(TargetKind::Stdout),
        ])
        .level(log::LevelFilter::Info)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .build()
}

/// Bring the window forward, e.g. when the app is started a second time.
#[cfg(desktop)]
fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Dropped files stay on this side; the UI only learns how many arrived and
/// then asks for them with `doc_add_dropped`.
fn on_window_event(window: &Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
        *window.state::<Dropped>().0.lock().unwrap() = paths.clone();
        let _ = window.emit("files-dropped", paths.len());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Only one copy may run: two would overwrite each other's saves. Starting
    // the app again (a double double-click) brings the open window forward.
    // Registered first, as the plugin requires.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)));
    builder
        .plugin(log_plugin())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Updates come from GitHub releases; the check runs in Rust, so the
            // window's CSP stays closed to the network.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let (dir, source) = data_dir(app.handle());
            log::info!("Orga-Neo {} starting, data folder {}", app.package_info().version, dir.display());
            app.manage(AppState(Mutex::new(Store::new(dir))));
            app.manage(DataDirs { source: Mutex::new(source), pending: Mutex::new(None) });
            app.manage(Dropped(Mutex::new(Vec::new())));
            Ok(())
        })
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            status,
            load_open,
            save_open,
            vault_create,
            vault_unlock,
            vault_unlock_code,
            vault_lock,
            vault_load,
            vault_save,
            vault_change_password,
            vault_new_codes,
            doc_pick_and_add,
            doc_add_dropped,
            doc_read,
            doc_delete,
            doc_export,
            doc_export_all,
            save_text_file,
            data_dir_pick,
            data_dir_apply,
            data_dir_reset
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orga-Neo");
}

#[cfg(test)]
mod tests {
    use super::safe_component;

    #[test]
    fn path_components_are_made_safe() {
        assert_eq!(safe_component("Bank & Rente"), "Bank & Rente");
        assert_eq!(safe_component("../../etc"), "_.._etc");
        assert_eq!(safe_component(".."), "_");
        assert_eq!(safe_component("a/b\\c:d"), "a_b_c_d");
        assert_eq!(safe_component("  "), "_");
    }
}
