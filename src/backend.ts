// The UI talks to storage only through this interface. Inside the installed
// app the Tauri backend is used (real files, real encryption). In a plain
// browser (`npm run dev`) a stand-in keeps everything in localStorage so the
// screens can be worked on without building the desktop app.

export interface Codes {
  recovery: string;
  emergency: string;
}

export interface AddedDoc {
  id: string;
  name: string;
  size: number;
}

export interface Status {
  initialized: boolean;
  unlocked: boolean;
  dataDir: string;
  /** Set by ORGA_NEO_DIR; the settings cannot change it. */
  dataDirFixed: boolean;
  /** The chosen data folder is not reachable (e.g. USB stick unplugged). */
  dataDirMissing: boolean;
  /** Folder with the log file ("" in the browser). */
  logDir: string;
}

/** A folder picked as new data folder. `path` is for display only. */
export interface PickedDir {
  path: string;
  hasData: boolean;
}

/** Called while an update downloads: percent 0–100, or null while the size is unknown. */
export type UpdateProgress = (percent: number | null, phase: "download" | "install") => void;

export interface Backend {
  kind: "tauri" | "browser";
  status(): Promise<Status>;
  loadOpen(): Promise<string>;
  saveOpen(json: string): Promise<void>;
  vaultCreate(password: string): Promise<Codes>;
  vaultUnlock(password: string): Promise<void>;
  vaultUnlockCode(code: string): Promise<void>;
  vaultLock(): Promise<void>;
  vaultLoad(): Promise<string>;
  vaultSave(json: string): Promise<void>;
  vaultChangePassword(password: string): Promise<void>;
  /** New codes and a new vault key; needs the current master password. */
  vaultNewCodes(password: string): Promise<Codes>;
  /** New master password, new codes and a new vault key at once. */
  vaultChangePasswordAndCodes(password: string): Promise<Codes>;
  /** Let the user pick files and store them encrypted. */
  pickAndAddDocs(): Promise<AddedDoc[]>;
  /** Store the files last dropped onto the window (desktop app only). */
  addDroppedDocs(): Promise<AddedDoc[]>;
  docRead(id: string): Promise<Uint8Array>;
  docDelete(id: string): Promise<void>;
  /** Save a decrypted copy. Resolves false when the user cancels. */
  docExport(id: string, fileName: string): Promise<boolean>;
  /** Write readable copies of all given documents into a folder the user picks. Resolves the number written, or -1 on cancel. */
  docExportAll(items: { id: string; folders: string[]; file: string }[]): Promise<number>;
  saveTextFile(fileName: string, contents: string): Promise<boolean>;
  /** Called with the number of files dropped onto the window. The paths stay in Rust. */
  onFileDrop(handler: (count: number) => void): void;
  bringToFront(): Promise<void>;
  /** Version of the running program, e.g. "0.2.0". */
  appVersion(): Promise<string>;
  /** Ask GitHub for a newer version. Resolves its version number, or null when up to date or no release exists yet. Throws "update_offline" or "update_check_failed". */
  checkUpdate(): Promise<string | null>;
  /** Download and install the update found by checkUpdate(), then restart. Throws "update_failed", or "update_restart" when only the restart failed. */
  installUpdate(onProgress: UpdateProgress): Promise<void>;
  /** Let the user pick a new data folder. Resolves null on cancel. */
  pickDataDir(): Promise<PickedDir | null>;
  /** Switch to the picked folder: "move" takes the data along, "use" opens the data already there. */
  applyDataDir(mode: "move" | "use"): Promise<void>;
  /** Go back to the standard folder Documents/Orga-Neo. Nothing is moved. */
  resetDataDir(): Promise<void>;
  /** Write an error to the log file. Never pass secrets or personal data. */
  logError(message: string): void;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  // File dialogs open on the Rust side: no command takes a path from here.
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const log = await import("@tauri-apps/plugin-log");
  const logError = (message: string) => {
    console.error(message);
    void log.error(message).catch(() => {});
  };
  return {
    kind: "tauri",
    status: () => invoke("status"),
    loadOpen: () => invoke("load_open"),
    saveOpen: (json) => invoke("save_open", { json }),
    vaultCreate: (password) => invoke("vault_create", { password }),
    vaultUnlock: (password) => invoke("vault_unlock", { password }),
    vaultUnlockCode: (code) => invoke("vault_unlock_code", { code }),
    vaultLock: () => invoke("vault_lock"),
    vaultLoad: () => invoke("vault_load"),
    vaultSave: (json) => invoke("vault_save", { json }),
    vaultChangePassword: (password) => invoke("vault_change_password", { password }),
    vaultNewCodes: (password) => invoke("vault_new_codes", { password }),
    vaultChangePasswordAndCodes: (password) => invoke("vault_change_password_and_codes", { password }),
    pickAndAddDocs: () => invoke("doc_pick_and_add"),
    addDroppedDocs: () => invoke("doc_add_dropped"),
    async docRead(id) {
      return new Uint8Array(await invoke<ArrayBuffer>("doc_read", { id }));
    },
    docDelete: (id) => invoke("doc_delete", { id }),
    docExport: (id, fileName) => invoke("doc_export", { id, fileName }),
    async docExportAll(items) {
      return (await invoke<number | null>("doc_export_all", { items })) ?? -1;
    },
    saveTextFile: (fileName, contents) => invoke("save_text_file", { fileName, contents }),
    onFileDrop(handler) {
      void listen<number>("files-dropped", (ev) => handler(ev.payload));
    },
    async bringToFront() {
      const w = getCurrentWindow();
      await w.unminimize();
      await w.show();
      await w.setFocus();
    },
    async appVersion() {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    // Check and install run in Rust, which sorts the errors and logs the details.
    checkUpdate: () => invoke("update_check"),
    async installUpdate(onProgress) {
      let total = 0;
      let done = 0;
      const onEvent = new Channel<{ event: "started"; total: number | null } | { event: "progress"; chunk: number } | { event: "installing" }>();
      onEvent.onmessage = (ev) => {
        if (ev.event === "started") {
          total = ev.total ?? 0;
          onProgress(total ? 0 : null, "download");
        } else if (ev.event === "progress") {
          done += ev.chunk;
          onProgress(total ? Math.min(100, Math.floor((done / total) * 100)) : null, "download");
        } else onProgress(100, "install");
      };
      await invoke("update_install", { onEvent });
      // On Windows the installer has already closed the app at this point.
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (err) {
        logError(`Restart after update failed: ${err}`);
        throw "update_restart";
      }
    },
    pickDataDir: () => invoke("data_dir_pick"),
    applyDataDir: (mode) => invoke("data_dir_apply", { mode }),
    resetDataDir: () => invoke("data_dir_reset"),
    logError,
  };
}

/** Stand-in for development in a browser. NOT encrypted. */
function browserBackend(): Backend {
  const K = "orga-neo-dev:";
  const get = (k: string) => localStorage.getItem(K + k);
  const set = (k: string, v: string) => localStorage.setItem(K + k, v);
  const docs = new Map<string, Uint8Array>();
  let unlocked = false;
  const code = () =>
    Array.from({ length: 4 }, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join(""),
    ).join("-");
  const norm = (c: string) => c.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const need = () => {
    if (!unlocked) throw "locked";
  };
  const desktopOnly = async (): Promise<never> => {
    throw "io: Nur in der installierten App möglich";
  };
  const makeCodes = (): Codes => {
    const c = { recovery: code(), emergency: code() };
    set("codes", JSON.stringify(c));
    return c;
  };
  const download = (name: string, data: BlobPart) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return {
    kind: "browser",
    status: async () => ({
      initialized: get("pw") !== null,
      unlocked,
      dataDir: "Browser-Vorschau (nicht verschlüsselt)",
      dataDirFixed: true,
      dataDirMissing: false,
      logDir: "",
    }),
    loadOpen: async () => get("open") ?? "",
    saveOpen: async (json) => set("open", json),
    async vaultCreate(password) {
      if (password.length < 10) throw "weak_password";
      set("pw", password);
      set("vault", '{"passwords":[],"docs":[]}');
      unlocked = true;
      return makeCodes();
    },
    async vaultUnlock(password) {
      if (get("pw") !== password) throw "wrong_secret";
      unlocked = true;
    },
    async vaultUnlockCode(c) {
      const codes = JSON.parse(get("codes") ?? "{}") as Partial<Codes>;
      if (norm(c) !== norm(codes.recovery ?? "-") && norm(c) !== norm(codes.emergency ?? "-")) throw "wrong_secret";
      unlocked = true;
    },
    async vaultLock() {
      unlocked = false;
    },
    async vaultLoad() {
      need();
      return get("vault") ?? "";
    },
    async vaultSave(json) {
      need();
      set("vault", json);
    },
    async vaultChangePassword(password) {
      need();
      if (password.length < 10) throw "weak_password";
      set("pw", password);
    },
    async vaultNewCodes(password) {
      need();
      if (get("pw") !== password) throw "wrong_secret";
      return makeCodes();
    },
    async vaultChangePasswordAndCodes(password) {
      need();
      if (password.length < 10) throw "weak_password";
      set("pw", password);
      return makeCodes();
    },
    pickAndAddDocs() {
      need();
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.onchange = async () => {
          const out: AddedDoc[] = [];
          for (const f of Array.from(input.files ?? [])) {
            const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
            docs.set(id, new Uint8Array(await f.arrayBuffer()));
            out.push({ id, name: f.name, size: f.size });
          }
          resolve(out);
        };
        input.oncancel = () => resolve([]);
        input.click();
      });
    },
    addDroppedDocs: async () => [],
    async docRead(id) {
      need();
      const d = docs.get(id);
      if (!d) throw "io: Dokument nur in dieser Browser-Sitzung verfügbar";
      return d;
    },
    async docDelete(id) {
      docs.delete(id);
    },
    async docExport(id, fileName) {
      const d = docs.get(id);
      if (!d) throw "io: Dokument nur in dieser Browser-Sitzung verfügbar";
      download(fileName, d as BlobPart);
      return true;
    },
    docExportAll: desktopOnly,
    async saveTextFile(fileName, contents) {
      download(fileName, contents);
      return true;
    },
    onFileDrop() {},
    async bringToFront() {
      window.focus();
    },
    // No updates in the browser preview.
    appVersion: async () => "Vorschau im Browser",
    checkUpdate: async () => null,
    async installUpdate() {
      throw "update_failed";
    },
    pickDataDir: desktopOnly,
    applyDataDir: desktopOnly,
    async resetDataDir() {},
    logError: (message) => console.error(message),
  };
}

export async function createBackend(): Promise<Backend> {
  return isTauri() ? tauriBackend() : browserBackend();
}
