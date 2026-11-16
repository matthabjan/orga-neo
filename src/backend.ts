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
  vaultNewCodes(): Promise<Codes>;
  /** Let the user pick files and store them encrypted. */
  pickAndAddDocs(): Promise<AddedDoc[]>;
  /** Store files dropped onto the window (desktop app only). */
  addDocPaths(paths: string[]): Promise<AddedDoc[]>;
  docRead(id: string): Promise<Uint8Array>;
  docDelete(id: string): Promise<void>;
  /** Save a decrypted copy. Resolves false when the user cancels. */
  docExport(id: string, fileName: string): Promise<boolean>;
  /** Write readable copies of all given documents into a folder the user picks. Resolves the number written, or -1 on cancel. */
  docExportAll(items: { id: string; folders: string[]; file: string }[]): Promise<number>;
  saveTextFile(fileName: string, contents: string): Promise<boolean>;
  onFileDrop(handler: (paths: string[]) => void): void;
  bringToFront(): Promise<void>;
  /** Version of the running program, e.g. "0.2.0". */
  appVersion(): Promise<string>;
  /** Ask GitHub for a newer version. Resolves its version number, or null when up to date. Throws "update_check_failed". */
  checkUpdate(): Promise<string | null>;
  /** Download and install the update found by checkUpdate(), then restart. Throws "update_failed", or "update_restart" when only the restart failed. */
  installUpdate(onProgress: UpdateProgress): Promise<void>;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const ext = (name: string) => (name.includes(".") ? name.split(".").pop()! : "");
  // Loaded on first use, so the start of the app does not wait for them.
  const updater = () => import("@tauri-apps/plugin-updater");
  let pending: import("@tauri-apps/plugin-updater").Update | null = null;
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
    vaultNewCodes: () => invoke("vault_new_codes"),
    async pickAndAddDocs() {
      const picked = await dialog.open({ multiple: true, title: "Dokumente auswählen" });
      if (!picked) return [];
      return invoke("doc_add_paths", { paths: Array.isArray(picked) ? picked : [picked] });
    },
    addDocPaths: (paths) => invoke("doc_add_paths", { paths }),
    async docRead(id) {
      return new Uint8Array(await invoke<ArrayBuffer>("doc_read", { id }));
    },
    docDelete: (id) => invoke("doc_delete", { id }),
    async docExport(id, fileName) {
      const e = ext(fileName);
      const path = await dialog.save({
        defaultPath: fileName,
        filters: e ? [{ name: e.toUpperCase(), extensions: [e] }] : undefined,
      });
      if (!path) return false;
      await invoke("doc_export", { id, path });
      return true;
    },
    async docExportAll(items) {
      const dir = await dialog.open({ directory: true, title: "Ordner für die Kopien auswählen" });
      if (!dir || Array.isArray(dir)) return -1;
      return invoke<number>("doc_export_all", { dir, items });
    },
    async saveTextFile(fileName, contents) {
      const e = ext(fileName);
      const path = await dialog.save({ defaultPath: fileName, filters: [{ name: e.toUpperCase(), extensions: [e] }] });
      if (!path) return false;
      await invoke("write_text_file", { path, contents });
      return true;
    },
    onFileDrop(handler) {
      void getCurrentWebview().onDragDropEvent((ev) => {
        if (ev.payload.type === "drop") handler(ev.payload.paths);
      });
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
    async checkUpdate() {
      try {
        const found = await (await updater()).check();
        pending?.close().catch(() => {});
        pending = found;
        return found?.version ?? null;
      } catch (err) {
        console.error("Update check failed:", err);
        throw "update_check_failed";
      }
    },
    async installUpdate(onProgress) {
      if (!pending) throw "update_failed";
      let total = 0;
      let done = 0;
      try {
        await pending.downloadAndInstall((ev) => {
          if (ev.event === "Started") {
            total = ev.data.contentLength ?? 0;
            onProgress(total ? 0 : null, "download");
          } else if (ev.event === "Progress") {
            done += ev.data.chunkLength;
            onProgress(total ? Math.min(100, Math.floor((done / total) * 100)) : null, "download");
          } else onProgress(100, "install");
        });
      } catch (err) {
        console.error("Update failed:", err);
        throw "update_failed";
      }
      // On Windows the installer has already closed the app at this point.
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (err) {
        console.error("Restart after update failed:", err);
        throw "update_restart";
      }
    },
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
    status: async () => ({ initialized: get("pw") !== null, unlocked, dataDir: "Browser-Vorschau (nicht verschlüsselt)" }),
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
    async vaultNewCodes() {
      need();
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
    addDocPaths: async () => [],
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
    async docExportAll() {
      throw "io: Nur in der installierten App möglich";
    },
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
  };
}

export async function createBackend(): Promise<Backend> {
  return isTauri() ? tauriBackend() : browserBackend();
}
