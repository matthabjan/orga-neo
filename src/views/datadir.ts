// Speicherort: choosing the data folder in the settings, and the screen shown
// when a chosen folder is not reachable at start (e.g. USB stick unplugged).

import { ic } from "../icons";
import { S, act, appName, confirmDialog, esc, flushOpen, toast } from "../state";

const NOTE_KEY = "orga-neo:after-reload";

/** Restart the interface on the new folder, with a message for after the reload. */
function reloadWith(note: string) {
  try {
    sessionStorage.setItem(NOTE_KEY, note);
  } catch {
    /* the message is a nicety */
  }
  location.reload();
}

/** Show the message left by `reloadWith`, once. */
export function showReloadNote() {
  try {
    const note = sessionStorage.getItem(NOTE_KEY);
    sessionStorage.removeItem(NOTE_KEY);
    if (note) toast(note);
  } catch {
    /* nothing to show */
  }
}

/** The "Speicherort" line in the settings' Daten card. */
export function vDataDirRow(): string {
  const change = S.dataDirFixed ? "" : `<button class="btn sec" data-act="data-dir-change">${ic("folder")}Speicherort ändern</button>`;
  return `<div class="ddir"><p class="hint-line">${ic("folder")}Speicherort: ${esc(S.dataDir)}</p>${change}</div>`;
}

/** Full screen instead of the app while the chosen folder cannot be reached. */
export function vMissing(): string {
  return `<div class="setup"><div class="setup-top"><div class="brand"><span class="rings" aria-hidden="true"><i></i><i></i><i></i></span>${esc(appName())}</div></div>
  <div class="setup-card"><h1>Ihre Daten sind gerade nicht erreichbar</h1>
    <p class="lead">Orga-Neo speichert Ihre Daten in diesem Ordner:</p>
    <p class="ddir-path">${esc(S.dataDir)}</p>
    <p class="lead">Wenn er auf einem USB-Stick oder einem anderen Laufwerk liegt: Schließen Sie es bitte an und klicken Sie dann auf „Erneut versuchen“.</p>
    <div class="btnrow"><button class="btn pri big" style="--accent:var(--ink)" data-act="data-dir-retry" autofocus>Erneut versuchen</button>
      <button class="btn ghost big" data-act="data-dir-reset">Standard-Speicherort verwenden</button></div>
  </div></div>`;
}

act("data-dir-retry", () => location.reload());

act("data-dir-reset", async () => {
  const ok = await confirmDialog(
    "Standard-Speicherort verwenden?",
    "Orga-Neo verwendet dann wieder den Ordner „Orga-Neo“ unter „Dokumente“. Die Daten im bisherigen Ordner bleiben unverändert und können später wieder gewählt werden.",
    "Standard verwenden",
  );
  if (!ok) return;
  await S.backend.resetDataDir();
  reloadWith("Orga-Neo verwendet jetzt den Standard-Speicherort.");
});

act("data-dir-change", async (el) => {
  const picked = await S.backend.pickDataDir();
  if (!picked) return;
  const ok = picked.hasData
    ? await confirmDialog(
        "Vorhandene Daten verwenden?",
        `In „${picked.path}“ liegen bereits Orga-Neo-Daten. Orga-Neo verwendet ab jetzt diese Daten. Ihre bisherigen Daten bleiben unverändert im alten Ordner.`,
        "Diese Daten verwenden",
      )
    : await confirmDialog(
        "Daten verschieben?",
        `Alle Termine, Kontakte, Notizen, Passwörter und Dokumente werden nach „${picked.path}“ verschoben. Das kann bei vielen Dokumenten einen Moment dauern.`,
        "Verschieben",
      );
  if (!ok) return;
  const btn = el as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = picked.hasData ? "Wird umgestellt …" : "Wird verschoben …";
  try {
    // Nothing typed may stay behind in the old folder.
    await flushOpen();
    await S.backend.applyDataDir(picked.hasData ? "use" : "move");
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = `${ic("folder")}Speicherort ändern`;
    throw e;
  }
  reloadWith(picked.hasData ? `Orga-Neo verwendet jetzt die Daten in „${picked.path}“.` : `Ihre Daten liegen jetzt in „${picked.path}“.`);
});
