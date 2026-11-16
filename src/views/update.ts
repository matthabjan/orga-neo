// Updates: a calm banner under the top bar when a newer version is on GitHub,
// and the "Programm" card in the settings.

import { ic } from "../icons";
import { S, act, errorText, esc, flushOpen, render, toast } from "../state";

let busy = false;
/** Progress or error text that replaces the offer while updating. */
let status = "";

/** The banner below the top bar, or "" when there is nothing to show. */
export function vUpdateBanner(): string {
  const u = S.update;
  if (!u || u.hidden) return "";
  return `<div class="upd" role="status">
    <span class="upd-t" id="upd-text">${esc(status || `Eine neue Version ist da (Version ${u.version}).`)}</span>
    <span class="hubsp"></span>
    <span class="upd-b" id="upd-buttons" ${busy ? "hidden" : ""}>
      <button class="btn pri" style="--accent:var(--ink)" data-act="update-now">${ic("download")}${status ? "Noch einmal versuchen" : "Jetzt aktualisieren"}</button>
      <button class="btn ghost" data-act="update-later">Später</button>
    </span></div>`;
}

/** The "Programm" card on the settings page. */
export function vProgramCard(): string {
  return `<section class="card"><h2>Programm</h2>
    <p class="lead">Installierte Version: ${esc(S.appVersion)}</p>
    ${S.logDir ? `<p class="hint-line">Protokolldatei für Hilfe aus der Ferne: ${esc(S.logDir)}</p>` : ""}
    <div class="btnrow"><button class="btn sec" data-act="update-check">Nach Updates suchen</button></div>
  </section>`;
}

const updateBlocked = () => S.view === "setup" || !!document.querySelector("dialog[open]");

/** Look for an update once, shortly after the start. Stays silent on every error (offline, no release). */
export function scheduleUpdateCheck() {
  if (S.backend.kind !== "tauri" || import.meta.env.DEV) return;
  window.setTimeout(async () => {
    try {
      const version = await S.backend.checkUpdate();
      if (!version) return;
      S.update = { version, hidden: false };
      // The banner appears with the next redraw if the user is typing or a dialog is open.
      if (S.view !== "setup" && !updateBlocked() && !document.activeElement?.matches("input,textarea,select")) render();
    } catch {
      // already logged by the backend
    }
  }, 10_000);
}

function setText(text: string) {
  status = text;
  const el = document.getElementById("upd-text");
  if (el) el.textContent = text;
}

act("update-later", () => {
  if (S.update) S.update.hidden = true;
  status = "";
  render();
});

act("update-check", async (el) => {
  if (busy) return;
  const btn = el as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Wird gesucht …";
  try {
    const version = await S.backend.checkUpdate();
    if (!version) {
      S.update = null;
      render();
      return toast("Sie haben die neueste Version.");
    }
    S.update = { version, hidden: false };
    status = "";
    render();
  } catch (e) {
    render();
    toast(errorText(e));
  }
});

act("update-now", async () => {
  if (busy || !S.update) return;
  if (updateBlocked()) return toast("Bitte schließen Sie zuerst das offene Fenster.");
  busy = true;
  document.getElementById("upd-buttons")?.setAttribute("hidden", "");
  setText("Wird vorbereitet …");
  try {
    // Nothing typed may be lost when the program closes for the update.
    await flushOpen();
    await S.backend.installUpdate((percent, phase) => {
      if (phase === "install") setText("Wird installiert … Das Programm startet gleich neu.");
      else setText(percent === null ? "Wird heruntergeladen …" : `Wird heruntergeladen … ${percent} %`);
    });
  } catch (e) {
    busy = false;
    status = errorText(e);
    render();
  }
});
