//! Thin bridge between the web UI and `orga-core`.
//! Everything the user sees lives in TypeScript; this file only exposes
//! file access and encryption as commands.

use std::path::PathBuf;
use std::sync::Mutex;

use orga_core::{Codes, Store};
use rand::RngCore;
use serde::Serialize;
use tauri::{ipc::Response, Manager, State};

/// Largest document the app accepts (bytes).
const MAX_DOC_SIZE: u64 = 50 * 1024 * 1024;

// Commands marked `async` run on a worker thread, so slow steps (key
// derivation, large files) do not freeze the window.
struct AppState(Mutex<Store>);

type CmdResult<T> = Result<T, String>;

fn e(err: orga_core::Error) -> String {
    err.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    initialized: bool,
    unlocked: bool,
    data_dir: String,
}

#[derive(Serialize)]
struct AddedDoc {
    id: String,
    name: String,
    size: u64,
}

#[tauri::command]
fn status(state: State<AppState>) -> Status {
    let s = state.0.lock().unwrap();
    Status {
        initialized: s.is_initialized(),
        unlocked: s.is_unlocked(),
        data_dir: s.dir().display().to_string(),
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
#[tauri::command(async)]
fn doc_add_paths(state: State<AppState>, paths: Vec<String>) -> CmdResult<Vec<AddedDoc>> {
    let store = state.0.lock().unwrap();
    let mut added = Vec::new();
    for p in paths {
        let path = PathBuf::from(&p);
        let meta = std::fs::metadata(&path).map_err(|err| format!("io: {err}"))?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_DOC_SIZE {
            return Err("too_large".into());
        }
        let bytes = std::fs::read(&path).map_err(|err| format!("io: {err}"))?;
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

#[tauri::command(async)]
fn doc_read(state: State<AppState>, id: String) -> CmdResult<Response> {
    let bytes = state.0.lock().unwrap().read_doc(&id).map_err(e)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn doc_delete(state: State<AppState>, id: String) -> CmdResult<()> {
    state.0.lock().unwrap().delete_doc(&id).map_err(e)
}

/// Write a decrypted copy of a document to a place the user picked.
#[tauri::command(async)]
fn doc_export(state: State<AppState>, id: String, path: String) -> CmdResult<()> {
    let bytes = state.0.lock().unwrap().read_doc(&id).map_err(e)?;
    std::fs::write(path, bytes).map_err(|err| format!("io: {err}"))
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

/// Write readable copies of documents into `dir`, in real folders that mirror
/// the folders shown in the app. Existing files are never overwritten.
#[tauri::command(async)]
fn doc_export_all(state: State<AppState>, dir: String, items: Vec<ExportItem>) -> CmdResult<u32> {
    let store = state.0.lock().unwrap();
    let mut count = 0;
    for item in items {
        let mut target = PathBuf::from(&dir);
        for f in &item.folders {
            target.push(safe_component(f));
        }
        std::fs::create_dir_all(&target).map_err(|err| format!("io: {err}"))?;
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
        std::fs::write(&path, bytes).map_err(|err| format!("io: {err}"))?;
        count += 1;
    }
    Ok(count)
}

/// Save an export (calendar, addresses, …) to a place the user picked.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    std::fs::write(path, contents).map_err(|err| format!("io: {err}"))
}

fn new_id() -> String {
    let mut b = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Data lives in `Documents/Orga-Neo` (on most Windows PCs that folder is
/// backed up by OneDrive). Set ORGA_NEO_DIR to use another folder.
fn data_dir(app: &tauri::App) -> PathBuf {
    if let Ok(dir) = std::env::var("ORGA_NEO_DIR") {
        return PathBuf::from(dir);
    }
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Orga-Neo")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Updates come from GitHub releases; the check runs in Rust, so the
            // window's CSP stays closed to the network.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let dir = data_dir(app);
            app.manage(AppState(Mutex::new(Store::new(dir))));
            Ok(())
        })
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
            doc_add_paths,
            doc_read,
            doc_delete,
            doc_export,
            doc_export_all,
            write_text_file
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
