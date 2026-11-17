// App state, saving, and the small UI toolkit every screen uses
// (actions, forms, dialogs, toasts).

import type { Backend, Codes } from "./backend";
import { AreaId, OpenData, VaultData, emptyOpen, startOfDay, ymd } from "./model";

export type View = "setup" | "missing" | "home" | "settings" | AreaId;

export const S = {
  backend: null as unknown as Backend,
  dataDir: "",
  /** Version of the running program, read from the app at start. */
  appVersion: "",
  /** The data folder is set by ORGA_NEO_DIR and cannot be changed in the settings. */
  dataDirFixed: false,
  logDir: "",
  data: emptyOpen() as OpenData,
  /** Passwords and document list; null while locked. */
  vault: null as VaultData | null,
  view: "home" as View,
  search: "",
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calSel: ymd(startOfDay(new Date())),
  /** Category ids currently hidden in the calendar. */
  calHidden: new Set<string>(),
  contactSel: "",
  noteSel: "",
  /** Selected document folder, "" for all. */
  docFolder: "",
  setup: { step: 1, firstName: "", sample: false, codes: null as Codes | null },
  saved: true,
  /** A newer version found on GitHub; `hidden` after "Später" until the next start. */
  update: null as { version: string; hidden: boolean } | null,
};

export const AREAS: Record<AreaId, { label: string; icon: string; c: string; t: string; locked: boolean }> = {
  cal: { label: "Termine", icon: "cal", c: "var(--plum)", t: "var(--plum-t)", locked: false },
  addr: { label: "Kontakte", icon: "person", c: "var(--petrol)", t: "var(--petrol-t)", locked: false },
  notes: { label: "Notizen", icon: "note", c: "var(--mustard)", t: "var(--mustard-t)", locked: false },
  docs: { label: "Dokumente", icon: "doc", c: "var(--blue)", t: "var(--blue-t)", locked: true },
  pw: { label: "Passwörter", icon: "key", c: "var(--green)", t: "var(--green-t)", locked: true },
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- rendering ----------

let renderFn = () => {};
export const setRender = (fn: () => void) => (renderFn = fn);
export const render = () => renderFn();

export function go(view: View) {
  S.view = view;
  S.search = "";
  render();
  document.getElementById("main")?.focus();
  window.scrollTo(0, 0);
}

// ---------- saving ----------

let openTimer: number | undefined;

function markSaved(ok: boolean) {
  S.saved = ok;
  const el = document.getElementById("saved");
  if (el) {
    el.textContent = ok ? "Alles gespeichert" : "Wird gespeichert …";
    el.classList.toggle("busy", !ok);
  }
}

async function guard(p: Promise<void>) {
  try {
    await p;
    markSaved(true);
  } catch (err) {
    toast("Speichern fehlgeschlagen: " + errorText(err));
  }
}

/** Save appointments, contacts, notes and settings (shortly after the last change). */
export function saveOpen() {
  markSaved(false);
  clearTimeout(openTimer);
  openTimer = window.setTimeout(() => void guard(S.backend.saveOpen(JSON.stringify(S.data))), 250);
}

/** Write a pending save now (before the app closes for an update). */
export async function flushOpen() {
  if (S.saved) return;
  clearTimeout(openTimer);
  await S.backend.saveOpen(JSON.stringify(S.data));
  markSaved(true);
}

/** Save passwords and the document list (encrypted). */
export async function saveVault() {
  if (!S.vault) return;
  markSaved(false);
  await guard(S.backend.vaultSave(JSON.stringify(S.vault)));
}

export function errorText(err: unknown): string {
  const code = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  const known: Record<string, string> = {
    wrong_secret: "Das Passwort stimmt nicht.",
    weak_password: "Das Passwort braucht mindestens 10 Zeichen.",
    locked: "Bitte zuerst mit dem Master-Passwort öffnen.",
    too_large: "Das Dokument ist größer als 50 MB.",
    corrupt: "Die Datei ist beschädigt und kann nicht gelesen werden.",
    not_initialized: "Orga-Neo ist noch nicht eingerichtet.",
    same_folder: "Das ist bereits der aktuelle Speicherort.",
    inside_current: "Der neue Speicherort darf nicht im bisherigen Ordner liegen.",
    target_has_data: "Im gewählten Ordner liegen bereits Orga-Neo-Daten.",
    backup_inside: "Die Sicherung darf nicht im Datenordner von Orga-Neo liegen. Wählen Sie zum Beispiel einen USB-Stick.",
    open_failed: "Für diesen Dateityp ist kein Programm eingerichtet. Speichern Sie eine Kopie und öffnen Sie diese.",
    unreadable: "Die Vorschau konnte die Datei nicht lesen.",
    dir_fixed: "Der Speicherort ist beim Start von Orga-Neo fest eingestellt worden und kann hier nicht geändert werden.",
    update_offline: "Die Suche nach Updates hat nicht geklappt. Bitte prüfen Sie die Internetverbindung und versuchen Sie es später noch einmal.",
    update_check_failed: "Die Suche nach Updates hat nicht geklappt. Bitte versuchen Sie es später noch einmal.",
    update_restart: "Das Update ist installiert. Bitte schließen Sie das Programm und öffnen Sie es wieder.",
    update_failed: "Das Update konnte nicht installiert werden. Bitte prüfen Sie die Internetverbindung und versuchen Sie es später noch einmal. Ihre Daten sind unverändert.",
  };
  return known[code] ?? code.replace(/^io: /, "");
}

// ---------- actions and forms ----------

export type ActionHandler = (el: HTMLElement, ev: Event) => void | Promise<void>;
export type FormHandler = (values: Record<string, string>, form: HTMLFormElement) => void | Promise<void>;

export const actions: Record<string, ActionHandler> = {};
export const forms: Record<string, FormHandler> = {};

/** Register what happens when an element with `data-act="name"` is clicked. */
export const act = (name: string, fn: ActionHandler) => (actions[name] = fn);
/** Register what happens when `<form data-form="name">` is submitted. */
export const form = (name: string, fn: FormHandler) => (forms[name] = fn);

// ---------- dialogs ----------

const dlg = () => document.getElementById("dlg") as HTMLDialogElement;
let onClose: (() => void) | null = null;

export function openDialog(html: string, opts: { wide?: boolean; onClose?: () => void } = {}) {
  const d = dlg();
  d.innerHTML = html;
  d.classList.toggle("wide", !!opts.wide);
  onClose = opts.onClose ?? null;
  if (!d.open) d.showModal();
}

export function closeDialog() {
  const d = dlg();
  if (d.open) d.close();
}

export function dialogClosed() {
  onClose?.();
  onClose = null;
  dlg().innerHTML = "";
}

/** Ask before deleting. Resolves true when the user confirms. */
export function confirmDialog(title: string, text: string, yes = "Löschen"): Promise<boolean> {
  return new Promise((resolve) => {
    const d = document.getElementById("confirm") as HTMLDialogElement;
    d.innerHTML = `<div class="db" style="padding-top:1.6rem"><h2 style="margin:0 0 .5rem;font-size:1.4rem">${esc(title)}</h2><p style="margin:0;color:var(--ink-2)">${esc(text)}</p></div>
      <div class="df"><button class="btn sec" value="no">Abbrechen</button><button class="btn danger-solid" value="yes">${esc(yes)}</button></div>`;
    d.onclick = (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) d.close(b.value);
    };
    d.onclose = () => resolve(d.returnValue === "yes");
    d.returnValue = "no";
    d.showModal();
  });
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  const a = document.getElementById("toast-area")!;
  a.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (a.innerHTML = ""), 3200);
}

export const appName = () => S.data.settings.appName || "Orga-Neo";

/** Apply name, text size and colour scheme to the page. */
export function applySettings() {
  const s = S.data.settings;
  const root = document.documentElement;
  root.dataset.size = s.textSize;
  root.dataset.scheme = s.scheme;
  document.title = appName();
}

/** Let the user pick files and read them as text (for imports). */
export function pickTextFiles(accept: string, multiple = false): Promise<{ name: string; text: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = async () => {
      const out = [];
      for (const f of Array.from(input.files ?? [])) out.push({ name: f.name, text: await f.text() });
      resolve(out);
    };
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
