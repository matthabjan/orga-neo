// Einstellungen: Anpassen, Kategorien, Sicherheit, Daten, Programm.

import type { Codes } from "../backend";
import { ic } from "../icons";
import { parseIcs, parsePasswordCsv, parseVcf, noteFromFile, notesToMarkdown, toIcs, toPasswordCsv, toVcf } from "../io";
import { ALL_AREAS, AreaId, BDAY_CAT, CAT_COLORS, Scheme, TextSize, newId } from "../model";
import { addSampleOpen, addSampleVault } from "../sample";
import { AREAS, S, act, appName, applySettings, closeDialog, confirmDialog, errorText, esc, form, openDialog, pickTextFiles, render, saveOpen, saveVault, toast } from "../state";
import { exportItems } from "./docs";
import { vDataDirRow } from "./datadir";
import { vProgramCard } from "./update";

const SIZES: [TextSize, string][] = [["m", "Normal"], ["l", "Groß"], ["xl", "Sehr groß"]];
const SCHEMES: [Scheme, string, string][] = [
  ["bunt", "Bunt", "Jeder Bereich hat seine eigene Farbe."],
  ["ruhig", "Ruhig", "Ein gedecktes Grün für alles."],
  ["kontrast", "Hoher Kontrast", "Schwarz auf Weiß, kräftige Linien."],
];

export function vSettings(): string {
  const s = S.data.settings;
  const text = (id: string, label: string, value: string, hint = "") =>
    `<div class="field"><label for="s-${id}">${label}</label><input class="inp" id="s-${id}" data-setting="${id}" value="${esc(value)}">${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const check = (id: string, label: string, on: boolean) =>
    `<label class="check"><input type="checkbox" data-toggle="${id}" ${on ? "checked" : ""}><span>${label}</span></label>`;

  const tiles = [...s.tiles, ...ALL_AREAS.filter((a) => !s.tiles.includes(a))];
  const tileRows = tiles
    .map((id) => {
      const on = s.tiles.includes(id);
      const i = s.tiles.indexOf(id);
      return `<li class="orow"><label class="check"><input type="checkbox" data-tile="${id}" ${on ? "checked" : ""}><span>${ic(AREAS[id].icon)}${AREAS[id].label}</span></label>
        <span class="hubsp"></span>
        <button class="iconbtn sm" data-act="tile-move" data-id="${id}" data-by="-1" aria-label="${AREAS[id].label} nach vorne" ${!on || i === 0 ? "disabled" : ""}>${ic("up")}</button>
        <button class="iconbtn sm" data-act="tile-move" data-id="${id}" data-by="1" aria-label="${AREAS[id].label} nach hinten" ${!on || i === s.tiles.length - 1 ? "disabled" : ""}>${ic("down")}</button></li>`;
    })
    .join("");

  const cats = s.categories
    .map(
      (c) => `<li class="orow"><span class="swatches" role="group" aria-label="Farbe für ${esc(c.name)}">${Object.entries(CAT_COLORS)
        .map(([k, v]) => `<button class="swatch" style="background:${v.c}" data-act="cat-color" data-id="${esc(c.id)}" data-color="${k}" aria-pressed="${c.color === k}" aria-label="${v.name}"></button>`)
        .join("")}</span>
      <input class="inp" data-cat-name="${esc(c.id)}" value="${esc(c.name)}" aria-label="Name der Kategorie">
      ${c.id === BDAY_CAT ? `<span class="fixed">aus Kontakten</span>` : `<button class="btn ghost" data-act="cat-delete" data-id="${esc(c.id)}">Löschen</button>`}</li>`,
    )
    .join("");

  const io = (label: string, hint: string, type: string) =>
    `<li class="orow"><span><b>${label}</b><br><span class="ev-m">${hint}</span></span><span class="hubsp"></span>
      <button class="btn sec" data-act="import" data-type="${type}">${ic("upload")}Importieren</button><button class="btn sec" data-act="export" data-type="${type}">${ic("download")}Exportieren</button></li>`;

  return `<header class="ph"><div><h1>Einstellungen</h1><p>Änderungen gelten sofort.</p></div></header>
  <div class="settings">
  <section class="card"><h2>Anpassen</h2>
    <div class="two">${text("appName", "Name des Programms", s.appName)}${text("firstName", "Ihr Vorname", s.firstName, "Für die Begrüßung auf der Startseite")}</div>
    ${text("tagline", "Leitspruch", s.tagline, "Steht auf dem Notfallblatt unter dem Namen")}
    <div class="field"><span class="lb">Schriftgröße</span><div class="chips" role="group" aria-label="Schriftgröße">${SIZES.map(([k, l]) => `<button class="chip" data-act="set-size" data-v="${k}" aria-pressed="${s.textSize === k}">${l}</button>`).join("")}</div></div>
    <div class="field"><span class="lb">Farben</span><div class="schemes" role="group" aria-label="Farben">${SCHEMES.map(([k, l, d]) => `<button class="scheme" data-act="set-scheme" data-v="${k}" aria-pressed="${s.scheme === k}"><span class="sw sw-${k}"><i></i><i></i><i></i></span><b>${l}</b><span>${d}</span></button>`).join("")}</div></div>
  </section>

  <section class="card"><h2>Startseite</h2>
    <p class="lead">Welche Bereiche als große Kacheln erscheinen, und in welcher Reihenfolge. Ausgeblendete Bereiche erreichen Sie weiterhin über die Suche.</p>
    <ul class="olist">${tileRows}</ul>
    <div class="checks">${check("showNext", "„Als Nächstes“ zeigen", s.showNext)}${check("showBirthdays", "Geburtstage zeigen", s.showBirthdays)}${check("showPinned", "Angeheftete Notizen zeigen", s.showPinned)}</div>
  </section>

  <section class="card"><h2>Kategorien für Termine</h2>
    <p class="lead">Jede Kategorie hat eine Farbe im Kalender. Geburtstage kommen automatisch aus den Kontakten.</p>
    <ul class="olist cats">${cats}</ul>
    <button class="btn sec" data-act="cat-add">${ic("plus")}Kategorie hinzufügen</button>
  </section>

  <section class="card"><h2>Sicherheit</h2>
    <p class="lead">Passwörter und Dokumente sind mit Ihrem Master-Passwort verschlüsselt. Termine, Kontakte und Notizen sind es nicht, damit Erinnerungen ohne Passwort erscheinen.</p>
    <div class="field"><label for="s-lock">Tresor automatisch schließen</label><select class="inp" id="s-lock" data-setting="autoLock" style="max-width:22rem">${[5, 10, 30, 60].map((m) => `<option value="${m}" ${s.autoLock === m ? "selected" : ""}>nach ${m} Minuten ohne Eingabe</option>`).join("")}</select></div>
    <div class="btnrow"><button class="btn sec" data-act="change-master">${ic("key")}Master-Passwort ändern</button><button class="btn sec" data-act="new-codes">${ic("print")}Neues Notfallblatt erstellen</button></div>
    ${S.vault ? "" : `<p class="hint-line">${ic("lock")}Dafür muss der Tresor geöffnet sein: Öffnen Sie zuerst Passwörter oder Dokumente.</p>`}
  </section>

  <section class="card"><h2>Daten</h2>
    <p class="lead">Übernehmen Sie Daten aus anderen Programmen oder speichern Sie eine Kopie in einem gängigen Format.</p>
    <ul class="olist">${io("Termine", "Kalenderdatei (.ics), z. B. aus Outlook oder Google", "ics")}${io("Kontakte", "Visitenkarten (.vcf), z. B. vom Handy", "vcf")}${io("Notizen", "Textdateien (.txt, .md)", "notes")}${io("Passwörter", "Tabelle (.csv), z. B. aus Edge, Chrome oder Bitwarden", "csv")}
      <li class="orow"><span><b>Dokumente</b><br><span class="ev-m">Lesbare Kopien aller Dokumente in echten Ordnern</span></span><span class="hubsp"></span><button class="btn sec" data-act="export-all-docs">${ic("folder")}Alle exportieren</button></li></ul>
    ${vDataDirRow()}
    <div class="btnrow"><button class="btn ghost" data-act="load-sample">Beispieldaten zum Ausprobieren laden</button></div>
  </section>

  ${vProgramCard()}
  </div>`;
}

/** Text fields and selects on the settings page save as you type. */
export function settingInput(el: HTMLInputElement | HTMLSelectElement) {
  const s = S.data.settings;
  const key = el.dataset.setting;
  if (key === "appName") s.appName = el.value.slice(0, 30);
  else if (key === "firstName") s.firstName = el.value.trim().slice(0, 40);
  else if (key === "tagline") s.tagline = el.value.slice(0, 80);
  else if (key === "autoLock") s.autoLock = Number(el.value);
  else if (el.dataset.catName) {
    const c = s.categories.find((x) => x.id === el.dataset.catName);
    if (c) c.name = el.value.slice(0, 40);
  } else if (el.dataset.toggle) (s as unknown as Record<string, boolean>)[el.dataset.toggle] = (el as HTMLInputElement).checked;
  else if (el.dataset.tile) {
    const id = el.dataset.tile as AreaId;
    s.tiles = (el as HTMLInputElement).checked ? [...s.tiles, id] : s.tiles.filter((t) => t !== id);
    saveOpen();
    return render();
  } else return;
  saveOpen();
  applySettings();
  const brand = document.querySelector(".hubbar .brand");
  if (brand?.lastChild) brand.lastChild.textContent = appName();
}

/** Print the recovery sheet (page 1) and the family's emergency key (page 2). */
export function printCodes(codes: Codes) {
  const s = S.data.settings;
  const page = (title: string, who: string, code: string, text: string) => `<section class="sheet-page">
    <p class="sp-brand">${esc(appName())}</p><p class="sp-tag">${esc(s.tagline)}</p>
    <h1>${title}</h1><p class="sp-who">${who}</p>
    <div class="sp-code">${esc(code)}</div>
    <p>${text}</p>
    <p class="sp-foot">Erstellt am ${new Date().toLocaleDateString("de-DE")}${s.firstName ? " für " + esc(s.firstName) : ""}. Ältere Blätter sind ungültig, sobald ein neues erstellt wurde.</p></section>`;
  document.getElementById("print")!.innerHTML =
    page("Notfallblatt", "Für Sie selbst. Bewahren Sie es zu Hause bei Ihren wichtigen Unterlagen auf.", codes.recovery, "Wenn Sie Ihr Master-Passwort vergessen haben: Öffnen Sie Passwörter oder Dokumente, klicken Sie auf „Passwort vergessen? Notfallblatt verwenden“ und geben Sie diesen Code ein. Legen Sie danach in den Einstellungen ein neues Master-Passwort fest.") +
    page("Notfallschlüssel für die Familie", "Für eine Person Ihres Vertrauens. Geben Sie dieses Blatt in einem verschlossenen Umschlag weiter.", codes.emergency, "Mit diesem Code kann die Familie im Notfall die Passwörter und Dokumente öffnen: in Passwörter oder Dokumente auf „Passwort vergessen? Notfallblatt verwenden“ klicken und den Code eingeben.");
  window.print();
}

export function codesHtml(codes: Codes): string {
  return `<div class="codes"><div><span class="lb">Ihr Notfallblatt</span><div class="code">${esc(codes.recovery)}</div></div>
    <div><span class="lb">Notfallschlüssel für die Familie</span><div class="code">${esc(codes.emergency)}</div></div></div>`;
}

const needVault = () => {
  if (S.vault) return true;
  toast("Öffnen Sie zuerst Passwörter oder Dokumente mit Ihrem Master-Passwort.");
  return false;
};

act("set-size", (el) => {
  S.data.settings.textSize = el.dataset.v as TextSize;
  saveOpen();
  applySettings();
  render();
});
act("set-scheme", (el) => {
  S.data.settings.scheme = el.dataset.v as Scheme;
  saveOpen();
  applySettings();
  render();
});
act("tile-move", (el) => {
  const t = S.data.settings.tiles;
  const i = t.indexOf(el.dataset.id as AreaId);
  const j = i + Number(el.dataset.by);
  if (i < 0 || j < 0 || j >= t.length) return;
  [t[i], t[j]] = [t[j], t[i]];
  saveOpen();
  render();
});
act("cat-color", (el) => {
  const c = S.data.settings.categories.find((x) => x.id === el.dataset.id);
  if (!c) return;
  c.color = el.dataset.color!;
  saveOpen();
  render();
});
act("cat-add", () => {
  const used = S.data.settings.categories.map((c) => c.color);
  const color = Object.keys(CAT_COLORS).find((k) => !used.includes(k)) ?? "slate";
  S.data.settings.categories.push({ id: newId(), name: "Neue Kategorie", color });
  saveOpen();
  render();
  const inputs = document.querySelectorAll<HTMLInputElement>("[data-cat-name]");
  inputs[inputs.length - 1]?.select();
});
act("cat-delete", async (el) => {
  const s = S.data.settings;
  const c = s.categories.find((x) => x.id === el.dataset.id);
  const rest = s.categories.filter((x) => x.id !== el.dataset.id && x.id !== BDAY_CAT);
  if (!c) return;
  if (!rest.length) return toast("Mindestens eine Kategorie muss bleiben.");
  const used = S.data.events.filter((e) => e.cat === c.id).length;
  if (used && !(await confirmDialog(`Kategorie „${c.name}“ löschen?`, `${used} ${used === 1 ? "Termin wird" : "Termine werden"} nach „${rest[0].name}“ verschoben.`))) return;
  for (const e of S.data.events) if (e.cat === c.id) e.cat = rest[0].id;
  s.categories = s.categories.filter((x) => x.id !== c.id);
  S.calHidden.delete(c.id);
  saveOpen();
  render();
});

act("change-master", () => {
  if (!needVault()) return;
  openDialog(`<form data-form="master" novalidate>
    <div class="dh"><h2 id="dlg-title">Master-Passwort ändern</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db"><div class="field"><label for="m1">Neues Master-Passwort</label><div class="pw-wrap"><input class="inp" id="m1" name="a" type="password" autocomplete="new-password" autofocus><button class="btn ghost" type="button" data-act="toggle-secret" data-for="m1 m2">${ic("eye")}<span>Zeigen</span></button></div><div class="hint">Mindestens 10 Zeichen. Gut merkbar sind drei oder vier Wörter hintereinander.</div></div>
      <div class="field"><label for="m2">Noch einmal eingeben</label><input class="inp" id="m2" name="b" type="password" autocomplete="new-password"></div>
      <p class="err" id="form-err" role="alert"></p></div>
    <div class="df"><button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--ink)">Ändern</button></div></form>`);
});
form("master", async (v) => {
  const err = document.getElementById("form-err")!;
  if (v.a.length < 10) return void (err.textContent = "Das Passwort braucht mindestens 10 Zeichen.");
  if (v.a !== v.b) return void (err.textContent = "Die beiden Eingaben sind verschieden.");
  try {
    await S.backend.vaultChangePassword(v.a);
    closeDialog();
    toast("Master-Passwort geändert. Ihr Notfallblatt gilt weiter.");
  } catch (e) {
    err.textContent = errorText(e);
  }
});
act("new-codes", async () => {
  if (!needVault()) return;
  if (!(await confirmDialog("Neues Notfallblatt erstellen?", "Die Codes auf den alten Blättern funktionieren danach nicht mehr.", "Neu erstellen"))) return;
  try {
    const codes = await S.backend.vaultNewCodes();
    openDialog(`<div class="dh"><h2 id="dlg-title">Neue Notfall-Codes</h2></div>
      <div class="db"><p>Drucken Sie beide Blätter jetzt aus. Die Codes werden nicht noch einmal angezeigt.</p>${codesHtml(codes)}</div>
      <div class="df"><button class="btn sec" data-act="print-codes">${ic("print")}Drucken</button><button class="btn pri" style="--accent:var(--ink)" data-act="close">Ich habe sie gedruckt</button></div>`);
    lastCodes = codes;
  } catch (e) {
    toast(errorText(e));
  }
});
let lastCodes: Codes | null = null;
export const rememberCodes = (c: Codes) => (lastCodes = c);
act("print-codes", () => {
  if (lastCodes) printCodes(lastCodes);
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

act("import", async (el) => {
  const type = el.dataset.type!;
  try {
    if (type === "ics") {
      const cat = S.data.settings.categories.find((c) => c.id !== BDAY_CAT)!.id;
      const list = (await pickTextFiles(".ics,text/calendar", true)).flatMap((f) => parseIcs(f.text, cat));
      if (!list.length) return toast("Keine Termine in der Datei gefunden.");
      S.data.events.push(...list);
      saveOpen();
      toast(plural(list.length, "Termin", "Termine") + " importiert.");
    } else if (type === "vcf") {
      const list = (await pickTextFiles(".vcf,text/vcard", true)).flatMap((f) => parseVcf(f.text));
      if (!list.length) return toast("Keine Kontakte in der Datei gefunden.");
      S.data.contacts.push(...list);
      saveOpen();
      toast(plural(list.length, "Kontakt", "Kontakte") + " importiert.");
    } else if (type === "notes") {
      const list = (await pickTextFiles(".txt,.md,text/plain", true)).map((f) => noteFromFile(f.name, f.text));
      if (!list.length) return;
      S.data.notes.push(...list);
      saveOpen();
      toast(plural(list.length, "Notiz", "Notizen") + " importiert.");
    } else {
      if (!needVault()) return;
      const files = await pickTextFiles(".csv,text/csv");
      if (!files.length) return;
      const list = files.flatMap((f) => parsePasswordCsv(f.text));
      if (!list.length) return toast("In der Datei wurde keine Spalte „password“ gefunden.");
      S.vault!.passwords.push(...list);
      await saveVault();
      toast(plural(list.length, "Passwort", "Passwörter") + " importiert. Löschen Sie die CSV-Datei jetzt: Sie ist nicht verschlüsselt.");
    }
    render();
  } catch (e) {
    toast(errorText(e));
  }
});
act("export", async (el) => {
  const type = el.dataset.type!;
  try {
    let ok = false;
    if (type === "ics") ok = await S.backend.saveTextFile("Termine.ics", toIcs(S.data.events));
    else if (type === "vcf") ok = await S.backend.saveTextFile("Kontakte.vcf", toVcf(S.data.contacts));
    else if (type === "notes") ok = await S.backend.saveTextFile("Notizen.md", notesToMarkdown(S.data.notes));
    else {
      if (!needVault()) return;
      if (!(await confirmDialog("Passwörter unverschlüsselt speichern?", "Die Datei enthält alle Passwörter im Klartext. Jeder, der sie öffnet, kann sie lesen.", "Trotzdem speichern"))) return;
      ok = await S.backend.saveTextFile("Passwoerter.csv", toPasswordCsv(S.vault!.passwords));
    }
    if (ok) toast("Gespeichert.");
  } catch (e) {
    toast(errorText(e));
  }
});
act("export-all-docs", async () => {
  if (!needVault()) return;
  if (!S.vault!.docs.length) return toast("Es sind noch keine Dokumente abgelegt.");
  try {
    const n = await S.backend.docExportAll(exportItems());
    if (n >= 0) toast(plural(n, "Dokument", "Dokumente") + " als lesbare Kopie gespeichert. Diese Kopien sind nicht verschlüsselt.");
  } catch (e) {
    toast(errorText(e));
  }
});
act("load-sample", async () => {
  if (!(await confirmDialog("Beispieldaten laden?", "Es werden erfundene Termine, Kontakte und Notizen hinzugefügt" + (S.vault ? ", dazu drei Beispiel-Passwörter." : "."), "Laden"))) return;
  addSampleOpen(S.data);
  saveOpen();
  if (S.vault) {
    addSampleVault(S.vault);
    await saveVault();
  }
  render();
  toast("Beispieldaten geladen.");
});
