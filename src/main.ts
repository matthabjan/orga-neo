import "./base.css";
import "./styles.css";

import { createBackend } from "./backend";
import { normalizeOpen } from "./model";
import { AREAS, S, act, actions, applySettings, closeDialog, dialogClosed, errorText, forms, render, setRender, toast } from "./state";
import { vCal } from "./views/cal";
import { vContacts } from "./views/contacts";
import { registerDocs, vDocs } from "./views/docs";
import { shell, vHome } from "./views/home";
import { noteInput, vNotes } from "./views/notes";
import { vPasswords } from "./views/passwords";
import { checkReminders, initReminders } from "./views/reminders";
import { settingInput, vSettings } from "./views/settings";
import { showReloadNote, vMissing } from "./views/datadir";
import { vSetup } from "./views/setup";
import { scheduleUpdateCheck } from "./views/update";
import { lockVault, vGate } from "./views/vault";

const root = document.getElementById("root")!;

setRender(() => {
  const v = S.view;
  if (v === "setup") {
    root.innerHTML = vSetup();
    // browsers honour `autofocus` only on page load, so do it by hand
    root.querySelector<HTMLElement>("[autofocus]")?.focus();
    return;
  }
  if (v === "missing") {
    root.innerHTML = vMissing();
    root.querySelector<HTMLElement>("[autofocus]")?.focus();
    return;
  }
  const area = v === "home" || v === "settings" ? null : AREAS[v];
  document.documentElement.style.setProperty("--accent", area?.c ?? "var(--slate)");
  document.documentElement.style.setProperty("--accent-t", area?.t ?? "var(--slate-t)");
  let inner: string;
  if (v === "home") inner = vHome();
  else if (v === "settings") inner = vSettings();
  else if (area!.locked && !S.vault) inner = vGate(v);
  else inner = { cal: vCal, addr: vContacts, notes: vNotes, docs: vDocs, pw: vPasswords }[v]();
  root.innerHTML = shell(inner);
  if (!document.querySelector("dialog[open]")) root.querySelector<HTMLElement>("[autofocus]")?.focus();
});

act("close", () => closeDialog());

// One listener per event type; elements say what they do with data-act / data-form.
document.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const fn = actions[el.dataset.act!];
  if (fn) void Promise.resolve(fn(el, ev)).catch((e) => toast(errorText(e)));
});

document.addEventListener("submit", (ev) => {
  const f = ev.target as HTMLFormElement;
  const fn = forms[f.dataset.form ?? ""];
  if (!fn) return;
  ev.preventDefault();
  const values: Record<string, string> = {};
  new FormData(f).forEach((v, k) => (values[k] = String(v)));
  void Promise.resolve(fn(values, f)).catch((e) => toast(errorText(e)));
});

document.addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.id === "q") {
    S.search = el.value;
    const pos = el.selectionStart;
    render();
    const again = document.getElementById("q") as HTMLInputElement | null;
    again?.focus();
    if (pos !== null) again?.setSelectionRange(pos, pos);
  } else if (el.id === "note-title" || el.id === "note-text") noteInput(el);
  else if (el.dataset.setting || el.dataset.catName) settingInput(el);
});

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.toggle || el.dataset.tile || el.tagName === "SELECT") settingInput(el);
});

document.getElementById("dlg")!.addEventListener("close", dialogClosed);

// Close the vault after a while without input.
let lastInput = Date.now();
for (const type of ["pointerdown", "keydown", "wheel"]) document.addEventListener(type, () => (lastInput = Date.now()), { passive: true });
setInterval(() => {
  if (S.vault && S.view !== "setup" && Date.now() - lastInput > S.data.settings.autoLock * 60_000)
    void lockVault().then(() => {
      render();
      toast("Der Tresor wurde nach längerer Pause geschlossen.");
    });
}, 15_000);

async function boot() {
  S.backend = await createBackend();
  const status = await S.backend.status();
  S.dataDir = status.dataDir;
  S.dataDirFixed = status.dataDirFixed;
  S.logDir = status.logDir;
  // Unexpected errors go to the log file, for help from a distance.
  window.addEventListener("error", (ev) => S.backend.logError(`UI error: ${ev.message} (${ev.filename}:${ev.lineno})`));
  window.addEventListener("unhandledrejection", (ev) => S.backend.logError(`Unhandled: ${ev.reason}`));
  if (status.dataDirMissing) {
    // Never fall through to the setup: that would start a second, empty vault.
    S.view = "missing";
    return render();
  }
  S.appVersion = await S.backend.appVersion().catch(() => "");
  try {
    S.data = normalizeOpen(JSON.parse((await S.backend.loadOpen()) || "null"));
  } catch {
    toast("Die gespeicherten Daten konnten nicht gelesen werden. Im Ordner „backups“ liegt eine Sicherung.");
  }
  // A vault left open by a reload is closed again: the UI starts locked.
  if (status.unlocked) await S.backend.vaultLock();
  S.view = status.initialized ? "home" : "setup";
  applySettings();
  render();
  showReloadNote();
  S.backend.onFileDrop((count) => {
    if (!count) return;
    if (S.view !== "docs" || !S.vault) return toast("Öffnen Sie „Dokumente“, um Dateien abzulegen.");
    void S.backend.addDroppedDocs().then(registerDocs, (e) => toast(errorText(e)));
  });
  initReminders();
  scheduleUpdateCheck();
  // Redraw around midnight so "Heute" stays right, and when the window is shown again.
  setInterval(() => !document.querySelector("dialog[open]") && !document.activeElement?.matches("input,textarea,select") && S.view === "home" && render(), 10 * 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && checkReminders());
}

void boot();
