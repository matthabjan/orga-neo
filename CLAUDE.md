# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Orga-Neo is an early-prototype desktop organizer for seniors (appointments, contacts, notes, encrypted documents and passwords). Tauri 2 app: a framework-free TypeScript UI in `src/` and a Rust storage/crypto layer in `src-tauri/`. **All user-facing text is German**, and the audience is elderly users: large type, plain wording, one way back to the start page. Keep new UI text in the same calm, formal ("Sie") German.

## Commands

```sh
npm install
npm run dev                 # UI only, browser at localhost:1420 (localStorage stand-in, NOT encrypted)
npm run tauri dev           # real desktop app
npm run build               # tsc --noEmit (strict, noUnused*) + vite build — this is the type check
npm test                    # vitest: src/io.test.ts (import/export + calendar logic)
npx vitest run -t "iCalendar"            # single test/describe by name
cd src-tauri && cargo test -p orga-core  # storage + encryption tests
cd src-tauri && cargo test -p orga-core <name>   # single Rust test
```

There is no linter configured. CI (`.github/workflows/build.yml`) runs `npm test`, `npm run build`, and `cargo test -p orga-core` on Ubuntu. Pushes to `main` or `develop` and PRs then build an unsigned NSIS installer with `createUpdaterArtifacts` switched off (no signing key there); a `v*` tag instead runs the `release` job, which signs the update with the `TAURI_SIGNING_PRIVATE_KEY*` secrets and publishes a GitHub release with `latest.json` via `tauri-action`. The version lives in `package.json` and `src-tauri/Cargo.toml`; `tauri.conf.json` points at `../package.json` (`npm run release -- vX.Y.Z` checks all of this). Changes touching only `README.md`/`CLAUDE.md`/`LICENSE` skip CI, a newer push cancels the older run on the same ref, and test installers build without LTO (`CARGO_PROFILE_RELEASE_*` env) while releases keep the `Cargo.toml` profile. Set `ORGA_NEO_DIR` to point the desktop app at a throwaway data folder instead of `Documents/Orga-Neo`.

## Architecture

### Layering: UI → `Backend` → Tauri bridge → `orga-core`

- `src/backend.ts` defines the `Backend` interface — the **only** way the UI touches storage. It has two implementations: `tauriBackend` (calls `invoke`) and `browserBackend` (localStorage, unencrypted, for screen work only). Selected at runtime by checking `__TAURI_INTERNALS__`.
- `src-tauri/src/lib.rs` is a thin bridge: each `#[tauri::command]` wraps a `Store` method held in a `Mutex`. Slow commands (Argon2, file I/O) are `#[tauri::command(async)]`.
- `src-tauri/core/` (`orga-core`) is plain Rust with no Tauri dependency: the data folder layout, key slots, XChaCha20-Poly1305 sealing, daily backups, moving the data folder (`move_to`). All crypto tests live here. Key slots carry their own Argon2 settings (old files fall back to the file-wide `kdf`), and password/code changes rewrite the slots in `backups/vault-*.json` too.
- The data folder comes from `ORGA_NEO_DIR`, else `settings.json` in the app config dir (chosen in Einstellungen), else `Documents/Orga-Neo`. A chosen folder that is missing at start shows `views/datadir.ts`'s "missing" screen, never the setup.
- `tauri-plugin-single-instance` (registered first) keeps one copy running; `tauri-plugin-log` writes `Orga-Neo.log` to the app log dir. `Backend.logError()` sends UI errors there — never log secrets, names or contents.

**No command takes a file path from the webview.** File dialogs open in Rust (`tauri_plugin_dialog::DialogExt`), dropped files are kept in Rust (`Dropped`) and fetched with `doc_add_dropped`, and a picked data folder waits in `DataDirs.pending` until `data_dir_apply`. Keep it that way: the webview has no `dialog:` permission.

**Adding a storage operation touches four places:** the `Store` method in `core/src/lib.rs`, a command in `src-tauri/src/lib.rs` *and* its entry in `generate_handler![...]`, the `Backend` interface plus *both* implementations in `backend.ts`. New Tauri window APIs may also need a permission in `src-tauri/capabilities/default.json`; the CSP is in `tauri.conf.json`.

**Errors cross the boundary as string codes.** `orga_core::Error`'s `Display` strings (`wrong_secret`, `locked`, `weak_password`, `corrupt`, `io: …`) and bridge codes like `too_large` are mapped to German messages in `errorText()` in `src/state.ts`. The browser stand-in throws the same codes. Add a mapping there when introducing a new code.

### Two data blobs

- `open.json` (`OpenData` in `model.ts`): appointments, contacts, notes, settings — unencrypted so reminders work while the vault is locked. Saved debounced via `saveOpen()`.
- vault (`VaultData`): passwords, document metadata and folders — only in memory as `S.vault` while unlocked (`null` when locked). Saved via `saveVault()`. Document bytes are stored separately as `docs/<id>.enc`.

The Rust side treats both as opaque JSON strings; schema lives entirely in TypeScript. `normalizeOpen` / `normalizeVault` in `model.ts` fill defaults when loading, so add new fields there to keep old data files loading. Areas with `locked: true` in `AREAS` (`docs`, `pw`) show the unlock gate when `S.vault` is null; the vault auto-locks after `settings.autoLock` minutes idle and is always relocked on app start.

### UI pattern (no framework)

- Global mutable state is the `S` object in `src/state.ts`. Each view in `src/views/` exports a function returning an HTML string; `main.ts` re-renders the whole `#root` via `innerHTML` on `render()`. Always escape interpolated user data with `esc()`.
- Interaction is event delegation: elements carry `data-act="name"` / `<form data-form="name">`, and views register handlers at module load with `act(name, fn)` / `form(name, fn)`. Handlers mutate `S`, call `saveOpen()`/`saveVault()`, then `render()`. Rejected promises from handlers become toasts automatically.
- Text-entry fields that must not lose focus (note editor, settings inputs, search `#q`) are handled in `main.ts`'s `input`/`change` listeners and update the model/DOM without a full re-render — follow that path for new live-editing inputs.
- Dialogs: `openDialog(html)` into the shared `<dialog id="dlg">`; `confirmDialog()` for destructive actions.
- Updates: `views/update.ts` (banner under the top bar, "Programm" card) goes through `checkUpdate`/`installUpdate` on `Backend`; the browser stand-in is a no-op. The check runs in Rust (`tauri-plugin-updater`), so the CSP stays closed to the network.

### Domain logic

`model.ts` holds types and the date logic: `occurrences()` expands repeating events (`weekly`/`monthly`/`yearly`) and contacts' birthdays (synthetic `bday` category) into a date range; `dueReminders()` drives `views/reminders.ts`. Dates are stored as local `YYYY-MM-DD` strings (`ymd`/`parseYmd`), not ISO timestamps. `io.ts` handles `.ics`, `.vcf`, password `.csv` (Edge/Chrome/Bitwarden/KeePass) and text import/export; it's covered by `io.test.ts` with round-trip tests.

### Notes

- `Cargo.toml` optimises dependencies in dev profile because unoptimised Argon2 takes many seconds; `Store::with_kdf` lets tests use cheap KDF params.
- The encryption has tests but no independent security review — treat changes to `orga-core` with care and keep the tests passing.
