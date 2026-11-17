// Dokumente (inside the vault): folders with one level of subfolders.
// On disk every document is one encrypted file; folders exist only in the app.
// Deleted documents wait TRASH_DAYS days in the Papierkorb before their file goes.

import type { AddedDoc } from "../backend";
import { ic } from "../icons";
import { DocFolder, DocMeta, TRASH_DAYS, daysSinceBackup, expiredDocs, fmt, folderPath, newId, parseYmd, purgeDay, ymd } from "../model";
import type { Sheet } from "../office";
import { S, act, closeDialog, confirmDialog, errorText, esc, form, go, openDialog, render, saveOpen, saveVault, toast } from "../state";

/** Shown by the webview itself. */
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", txt: "text/plain" };
/** Shown through office.ts, loaded when first needed. */
const OFFICE: Record<string, "docx" | "xlsx" | "csv"> = { docx: "docx", xlsx: "xlsx", xlsm: "xlsx", csv: "csv" };
const ext = (file: string) => (file.includes(".") ? file.split(".").pop()!.toLowerCase() : "");
const isImage = (file: string) => (MIME[ext(file)] ?? "").startsWith("image/");
const kind = (file: string) => (isImage(file) ? "Foto" : ext(file).toUpperCase() || "Datei");
const size = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const day = (d: Date) => fmt(d, { day: "numeric", month: "long", year: "numeric" });
/** File name for exporting and opening: the title with the original extension. */
const fileName = (d: DocMeta) => (ext(d.file) ? `${d.title}.${ext(d.file)}` : d.title);

/** Id of the Papierkorb in the folder list (real folder ids never look like this). */
const TRASH = "papierkorb";

/** Documents in use, i.e. not in the Papierkorb. */
const live = () => S.vault!.docs.filter((d) => !d.deleted);
const binned = () => S.vault!.docs.filter((d) => d.deleted);
const children = (id: string) => S.vault!.folders.filter((f) => f.parent === id);
/** A folder's own id plus the ids of its subfolders. */
const subtree = (id: string) => [id, ...children(id).map((f) => f.id)];
const docsIn = (ids: string[]) => live().filter((d) => ids.includes(d.folder));

function tile(d: DocMeta): string {
  const page = isImage(d.file)
    ? `<div class="page photo"><div class="card"></div><span class="ft">Foto</span></div>`
    : `<div class="page"><div class="ln h"></div>${'<div class="ln"></div>'.repeat(3)}<div class="ln" style="width:70%"></div><div class="ln" style="margin-top:.9rem"></div><div class="ln" style="width:85%"></div><span class="ft">${esc(kind(d.file))}</span></div>`;
  return `<button class="doc" data-act="open-doc" data-id="${d.id}">${page}<span class="t">${esc(d.title)}</span><span class="m">Abgelegt am ${fmt(parseYmd(d.date), { day: "numeric", month: "short", year: "numeric" })}</span></button>`;
}

/** A calm line when there is no recent backup of the documents. */
function backupNote(): string {
  if (!live().length) return "";
  const days = daysSinceBackup(S.data.settings, new Date());
  if (days !== null && days <= 30) return "";
  const text = days === null ? "Von Ihren Dokumenten gibt es noch keine Datensicherung." : "Ihre letzte Datensicherung ist über einen Monat her.";
  return `<p class="hint-line backup-note">${ic("bell")}${text}<button class="btn ghost" data-act="backup-create">${ic("download")}Jetzt sichern</button></p>`;
}

function vTrash(): string {
  const list = binned().sort((a, b) => b.deleted!.localeCompare(a.deleted!));
  const rows = list
    .map(
      (d) => `<li class="orow"><span><b>${esc(d.title)}</b><br><span class="ev-m">Gelöscht am ${day(parseYmd(d.deleted!))}, wird am ${day(purgeDay(d))} endgültig entfernt</span></span><span class="hubsp"></span>
      <button class="btn sec" data-act="restore-doc" data-id="${d.id}">Wiederherstellen</button><button class="btn ghost" data-act="purge-doc" data-id="${d.id}">Endgültig löschen</button></li>`,
    )
    .join("");
  return `<div class="fbar"><h2>Papierkorb</h2><span class="hubsp"></span>${list.length ? `<button class="btn ghost" data-act="empty-trash">Papierkorb leeren</button>` : ""}</div>
    ${list.length ? `<p class="lead trash-lead">Gelöschte Dokumente bleiben ${TRASH_DAYS} Tage hier. Danach werden sie endgültig gelöscht.</p><ul class="olist">${rows}</ul>` : `<div class="blank small">${ic("trash")}<h2>Der Papierkorb ist leer</h2><p>Gelöschte Dokumente bleiben ${TRASH_DAYS} Tage hier, bevor sie endgültig verschwinden.</p></div>`}`;
}

export function vDocs(): string {
  const v = S.vault!;
  const top = v.folders.filter((f) => !f.parent);
  const inTrash = S.docFolder === TRASH;
  const cur = v.folders.find((f) => f.id === S.docFolder);
  const item = (f: DocFolder, sub: boolean) =>
    `<li><button class="frow ${sub ? "sub" : ""}" data-act="doc-folder" data-id="${f.id}" ${f.id === S.docFolder ? 'aria-current="true"' : ""}>${ic("folder")}<span>${esc(f.name)}</span><small>${docsIn(sub ? [f.id] : subtree(f.id)).length}</small></button></li>`;
  const tree = `<ul class="ftree"><li><button class="frow" data-act="doc-folder" data-id="" ${!cur && !inTrash ? 'aria-current="true"' : ""}>${ic("doc")}<span>Alle Dokumente</span><small>${live().length}</small></button></li>
    ${top.map((f) => item(f, false) + children(f.id).map((c) => item(c, true)).join("")).join("")}
    <li class="trash-row"><button class="frow" data-act="doc-folder" data-id="${TRASH}" ${inTrash ? 'aria-current="true"' : ""}>${ic("trash")}<span>Papierkorb</span><small>${binned().length}</small></button></li></ul>
    <button class="btn sec" data-act="new-folder" data-parent="" style="width:100%;margin-top:.8rem">${ic("plus")}Neuer Ordner</button>`;

  let body: string;
  if (inTrash) body = vTrash();
  else {
    const groups: { title: string; docs: DocMeta[] }[] = [];
    if (!cur) for (const f of top) groups.push({ title: f.name, docs: docsIn(subtree(f.id)) });
    else {
      groups.push({ title: "", docs: docsIn([cur.id]) });
      for (const c of children(cur.id)) groups.push({ title: c.name, docs: docsIn([c.id]) });
    }
    const shown = groups.filter((g) => g.docs.length);
    const grid = shown.length
      ? shown.map((g) => `<section class="dgroup">${g.title ? `<h2>${esc(g.title)}</h2>` : ""}<div class="docs">${g.docs.sort((a, b) => a.title.localeCompare(b.title, "de")).map(tile).join("")}</div></section>`).join("")
      : `<div class="blank small">${ic("doc")}<h2>${cur ? "Dieser Ordner ist leer" : "Noch keine Dokumente"}</h2><p>Legen Sie Ausweise, Verträge und Bescheide als PDF oder Foto ab. Sie können Dateien auch einfach in dieses Fenster ziehen.</p></div>`;
    const folderBar = cur
      ? `<div class="fbar"><h2>${folderPath(v.folders, cur.id).map(esc).join(" › ")}</h2><span class="hubsp"></span>
          ${!cur.parent ? `<button class="btn ghost" data-act="new-folder" data-parent="${cur.id}">${ic("plus")}Unterordner</button>` : ""}
          <button class="btn ghost" data-act="rename-folder" data-id="${cur.id}">Umbenennen</button>
          <button class="btn ghost" data-act="delete-folder" data-id="${cur.id}">Ordner löschen</button></div>`
      : "";
    body = folderBar + grid;
  }

  return `<header class="ph"><div><h1>Dokumente</h1><p>Ihre wichtigen Unterlagen, verschlüsselt und nach Ordnern sortiert.</p></div>
  <button class="btn pri big" data-act="add-docs">${ic("plus")}Dokument ablegen</button></header>
  ${backupNote()}
  <div class="split docsplit"><nav aria-label="Ordner">${tree}</nav><div>${body}</div></div>`;
}

const folderOptions = (sel: string) =>
  S.vault!.folders
    .filter((f) => !f.parent)
    .flatMap((f) => [f, ...children(f.id)])
    .map((f) => `<option value="${f.id}" ${f.id === sel ? "selected" : ""}>${esc(folderPath(S.vault!.folders, f.id).join(" › "))}</option>`)
    .join("");

// ---------- adding, and what happens to the originals ----------

/** Documents just added whose originals the user is being asked about. */
let pendingOriginals: string[] = [];

/** Register freshly encrypted files in the document list. */
export async function registerDocs(added: AddedDoc[]) {
  if (!S.vault || !added.length) return;
  const folder = S.docFolder && S.docFolder !== TRASH ? S.docFolder : S.vault.folders[0]?.id || "";
  for (const a of added) S.vault.docs.push({ id: a.id, title: a.name.replace(/\.[^.]+$/, ""), folder, file: a.name, size: a.size, date: ymd(new Date()) });
  await saveVault();
  if (S.docFolder === TRASH) S.docFolder = folder;
  render();
  const stored = added.length === 1 ? `„${added[0].name}“ abgelegt.` : `${added.length} Dokumente abgelegt.`;
  const how = S.data.settings.originals;
  // The browser stand-in never knows where a file came from.
  if (S.backend.kind === "browser" || how === "keep") return toast(stored);
  if (how === "trash") return trashOriginals(added.map((a) => a.id));
  pendingOriginals = added.map((a) => a.id);
  const one = added.length === 1;
  const tip =
    daysSinceBackup(S.data.settings, new Date()) === null
      ? `<p class="hint-line">${ic("bell")}Tipp: Legen Sie in den Einstellungen unter „Datensicherung“ regelmäßig eine Sicherung an. Dann sind Ihre Dokumente auch geschützt, wenn der Computer einmal ausfällt.</p>`
      : "";
  openDialog(`<div class="dh"><h2 id="dlg-title">${one ? "Original-Datei" : "Original-Dateien"} in den Windows-Papierkorb?</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db"><p>${one ? `„${esc(added[0].name)}“ ist jetzt verschlüsselt in Orga-Neo abgelegt. Die ursprüngliche Datei liegt aber weiterhin ungeschützt auf Ihrem Computer.` : `${added.length} Dokumente sind jetzt verschlüsselt in Orga-Neo abgelegt. Die ursprünglichen Dateien liegen aber weiterhin ungeschützt auf Ihrem Computer.`}</p>
      <p>Orga-Neo prüft vorher, ob die verschlüsselte Kopie vollständig ist. Aus dem Windows-Papierkorb können Sie ${one ? "die Datei" : "die Dateien"} bei Bedarf zurückholen.</p>
      ${tip}
      <label class="check" style="margin-top:1rem"><input type="checkbox" id="orig-remember"><span>Diese Entscheidung merken und nicht mehr fragen</span></label>
      <div class="hint">Sie können das jederzeit in den Einstellungen unter „Sicherheit“ ändern.</div></div>
    <div class="df"><button type="button" class="btn sec" data-act="originals" data-v="keep">${one ? "Original behalten" : "Originale behalten"}</button><button type="button" class="btn pri" style="--accent:var(--blue)" data-act="originals" data-v="trash">In den Windows-Papierkorb</button></div>`);
}

async function trashOriginals(ids: string[]) {
  const moved = await S.backend.docTrashOriginals(ids);
  if (moved === ids.length) toast(ids.length === 1 ? "Abgelegt. Das Original liegt jetzt im Windows-Papierkorb." : `Abgelegt. Die ${ids.length} Originale liegen jetzt im Windows-Papierkorb.`);
  else toast(`${ids.length - moved} von ${ids.length} Originalen konnten nicht in den Windows-Papierkorb verschoben werden. Sie liegen noch am alten Ort.`);
}

act("originals", async (el) => {
  const choice = el.dataset.v as "keep" | "trash";
  if ((document.getElementById("orig-remember") as HTMLInputElement | null)?.checked) {
    S.data.settings.originals = choice;
    saveOpen();
  }
  const ids = pendingOriginals;
  pendingOriginals = [];
  closeDialog();
  if (choice === "trash") await trashOriginals(ids);
  else toast(ids.length === 1 ? "Abgelegt. Das Original bleibt, wo es war." : "Abgelegt. Die Originale bleiben, wo sie waren.");
});

// ---------- viewing ----------

/** Sheets of the spreadsheet in the open dialog, for switching between them. */
let sheets: Sheet[] = [];

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

function sheetHtml(i: number): string {
  const s = sheets[i];
  const tabs =
    sheets.length > 1
      ? `<div class="chips sheet-tabs" role="group" aria-label="Tabellenblätter">${sheets.map((x, j) => `<button type="button" class="chip" data-act="sheet-tab" data-i="${j}" aria-pressed="${i === j}">${esc(x.name)}</button>`).join("")}</div>`
      : "";
  if (!s.rows.length) return `${tabs}<p class="empty">Dieses Tabellenblatt ist leer.</p>`;
  const cols = Math.max(...s.rows.map((r) => r.length));
  const head = `<tr><th></th>${Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join("")}</tr>`;
  const body = s.rows.map((r, n) => `<tr><th>${n + 1}</th>${Array.from({ length: cols }, (_, c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
  const cut = s.cut ? `<p class="hint">Die Vorschau zeigt nur den Anfang der Tabelle. Alles sehen Sie mit „Im Programm öffnen“.</p>` : "";
  return `${tabs}<div class="xls-wrap"><table class="xls"><thead>${head}</thead><tbody>${body}</tbody></table></div>${cut}`;
}

act("sheet-tab", (el) => {
  const box = document.getElementById("doc-preview");
  if (box) box.innerHTML = sheetHtml(Number(el.dataset.i));
});

/** Fill the preview box of an office file once the library and the bytes are there. */
async function renderOffice(d: DocMeta, type: "docx" | "xlsx" | "csv") {
  const still = () => {
    const box = document.getElementById("doc-preview");
    return box?.dataset.id === d.id ? box : null;
  };
  try {
    const [bytes, office] = await Promise.all([S.backend.docRead(d.id), import("../office")]);
    let box = still();
    if (!box) return;
    if (type === "docx") {
      const page = document.createElement("div");
      await office.renderDocx(bytes, page);
      box = still();
      if (!box) return;
      box.replaceChildren(page);
      box.classList.add("docx-box");
      // Shrink the A4 pages to the dialog's width.
      const first = page.querySelector<HTMLElement>("section.docx");
      if (first && first.offsetWidth > box.clientWidth) page.style.zoom = String((box.clientWidth - 8) / (first.offsetWidth + 40));
    } else {
      sheets = type === "xlsx" ? await office.readXlsx(bytes) : [office.csvSheet(new TextDecoder().decode(bytes))];
      box = still();
      if (!box) return;
      box.innerHTML = sheets.length ? sheetHtml(0) : `<p class="empty">Die Tabelle enthält keine sichtbaren Blätter.</p>`;
    }
  } catch (e) {
    S.backend.logError(`Preview failed (${type}): ${e instanceof Error ? e.name : typeof e === "string" ? e : "unknown"}`);
    const box = still();
    if (box) box.innerHTML = `<p class="err">${typeof e === "string" && e !== "unreadable" ? esc(errorText(e)) : "Die Vorschau konnte die Datei nicht lesen."} Versuchen Sie „Im Programm öffnen“.</p>`;
  }
}

async function showDoc(d: DocMeta) {
  let url = "";
  let preview = `<p class="empty">Für diesen Dateityp gibt es keine Vorschau. Mit „Im Programm öffnen“ sehen Sie die Datei in dem Programm, das auf Ihrem Computer dafür eingerichtet ist.</p>`;
  const mime = MIME[ext(d.file)];
  const office = OFFICE[ext(d.file)];
  if (mime) {
    try {
      const bytes = await S.backend.docRead(d.id);
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      preview = mime.startsWith("image/") ? `<img class="preview" src="${url}" alt="${esc(d.title)}">` : `<iframe class="preview" src="${url}" title="${esc(d.title)}"></iframe>`;
    } catch (e) {
      preview = `<p class="err">${esc(errorText(e))}</p>`;
    }
  } else if (office) preview = `<div class="preview office" id="doc-preview" data-id="${d.id}"><p class="empty">Vorschau wird geladen …</p></div>`;
  openDialog(
    `<form data-form="doc" novalidate>
    <div class="dh"><div><h2 id="dlg-title">${esc(d.title)}</h2><div class="m">${esc(kind(d.file))}, ${size(d.size)}, abgelegt am ${day(parseYmd(d.date))}</div></div><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db">${preview}
      <input type="hidden" name="id" value="${d.id}">
      <div class="two" style="margin-top:1.2rem"><div class="field"><label for="d-title">Name</label><input class="inp" id="d-title" name="title" value="${esc(d.title)}" required></div>
      <div class="field"><label for="d-folder">Ordner</label><select class="inp" id="d-folder" name="folder">${folderOptions(d.folder)}</select></div></div>
    </div>
    <div class="df"><button type="button" class="btn danger left" data-act="delete-doc" data-id="${d.id}">Löschen</button><button type="button" class="btn sec" data-act="open-external" data-id="${d.id}">${ic("doc")}Im Programm öffnen</button><button type="button" class="btn sec" data-act="export-doc" data-id="${d.id}">${ic("download")}Kopie speichern</button><button class="btn pri" style="--accent:var(--blue)">Speichern</button></div></form>`,
    {
      wide: true,
      onClose: () => {
        sheets = [];
        if (url) URL.revokeObjectURL(url);
      },
    },
  );
  if (office) void renderOffice(d, office);
}

function folderDialog(f: DocFolder, isNew: boolean) {
  openDialog(`<form data-form="folder" novalidate>
    <div class="dh"><h2 id="dlg-title">${isNew ? (f.parent ? "Neuer Unterordner" : "Neuer Ordner") : "Ordner umbenennen"}</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db"><input type="hidden" name="id" value="${isNew ? "" : f.id}"><input type="hidden" name="parent" value="${f.parent}">
      <div class="field"><label for="fo-name">Name${f.parent && isNew ? ` <span class="opt">(in „${esc(S.vault!.folders.find((x) => x.id === f.parent)?.name ?? "")}“)</span>` : ""}</label><input class="inp" id="fo-name" name="name" value="${esc(f.name)}" required autofocus></div>
      <p class="err" id="form-err" role="alert"></p></div>
    <div class="df"><button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--blue)">Speichern</button></div></form>`);
}

const findDoc = (el: HTMLElement) => S.vault?.docs.find((x) => x.id === el.dataset.id);

act("doc-folder", (el) => {
  S.docFolder = el.dataset.id ?? "";
  render();
});
act("add-docs", async () => {
  try {
    await registerDocs(await S.backend.pickAndAddDocs());
  } catch (e) {
    toast(errorText(e));
  }
});
act("open-doc", async (el) => {
  const d = findDoc(el);
  if (!d || d.deleted) return;
  if (S.view !== "docs") go("docs");
  await showDoc(d);
});
act("open-external", async (el) => {
  const d = findDoc(el);
  if (!d) return;
  try {
    await S.backend.docOpen(d.id, fileName(d));
    toast(S.backend.kind === "browser" ? "Kopie heruntergeladen." : "Die Datei wird geöffnet. Änderungen daran werden nicht in Orga-Neo gespeichert.");
  } catch (err) {
    toast(errorText(err));
  }
});
act("export-doc", async (el) => {
  const d = findDoc(el);
  if (!d) return;
  try {
    if (await S.backend.docExport(d.id, fileName(d))) toast("Kopie gespeichert. Diese Kopie ist nicht verschlüsselt.");
  } catch (err) {
    toast(errorText(err));
  }
});
act("delete-doc", async (el) => {
  const d = findDoc(el);
  if (!d || !(await confirmDialog(`„${d.title}“ in den Papierkorb legen?`, `Sie können es dort ${TRASH_DAYS} Tage lang wiederherstellen. Danach wird es endgültig gelöscht.`, "In den Papierkorb"))) return;
  d.deleted = ymd(new Date());
  await saveVault();
  closeDialog();
  render();
  toast("In den Papierkorb gelegt.");
});
act("restore-doc", async (el) => {
  const d = findDoc(el);
  if (!d) return;
  delete d.deleted;
  const v = S.vault!;
  if (!v.folders.some((f) => f.id === d.folder)) d.folder = v.folders[0].id;
  await saveVault();
  render();
  toast(`„${d.title}“ liegt wieder in „${folderPath(v.folders, d.folder).join(" › ")}“.`);
});

/** Delete documents' files for good and drop them from the list. Resolves how many went. */
async function purge(list: DocMeta[]): Promise<number> {
  const gone = new Set<string>();
  for (const d of list) {
    try {
      await S.backend.docDelete(d.id);
      gone.add(d.id);
    } catch (e) {
      S.backend.logError(`Deleting a document failed: ${e}`);
    }
  }
  if (gone.size) {
    S.vault!.docs = S.vault!.docs.filter((x) => !gone.has(x.id));
    await saveVault();
  }
  return gone.size;
}

/** After unlocking: remove documents that have been in the Papierkorb long enough. */
export async function purgeExpired() {
  if (S.vault) await purge(expiredDocs(S.vault.docs, new Date()));
}

act("purge-doc", async (el) => {
  const d = findDoc(el);
  if (!d || !(await confirmDialog(`„${d.title}“ endgültig löschen?`, "Das Dokument kann danach nicht wiederhergestellt werden.", "Endgültig löschen"))) return;
  if (await purge([d])) toast("Dokument endgültig gelöscht.");
  render();
});
act("empty-trash", async () => {
  const list = binned();
  const n = list.length;
  if (!n || !(await confirmDialog("Papierkorb leeren?", `${n === 1 ? "Das Dokument im Papierkorb wird" : `Alle ${n} Dokumente im Papierkorb werden`} endgültig gelöscht und können nicht wiederhergestellt werden.`, "Endgültig löschen"))) return;
  const gone = await purge(list);
  render();
  toast(gone === n ? "Papierkorb geleert." : `${n - gone} Dokumente konnten nicht gelöscht werden.`);
});
act("new-folder", (el) => folderDialog({ id: "", name: "", parent: el.dataset.parent ?? "" }, true));
act("rename-folder", (el) => {
  const f = S.vault?.folders.find((x) => x.id === el.dataset.id);
  if (f) folderDialog(f, false);
});
act("delete-folder", async (el) => {
  const v = S.vault!;
  const f = v.folders.find((x) => x.id === el.dataset.id);
  if (!f) return;
  if (docsIn(subtree(f.id)).length) return toast("Der Ordner enthält noch Dokumente. Verschieben oder löschen Sie diese zuerst.");
  if (v.folders.filter((x) => !x.parent).length === 1 && !f.parent) return toast("Mindestens ein Ordner muss bleiben.");
  if (!(await confirmDialog(`Ordner „${f.name}“ löschen?`, "Der leere Ordner wird entfernt."))) return;
  const gone = subtree(f.id);
  v.folders = v.folders.filter((x) => !gone.includes(x.id));
  // Documents from it in the Papierkorb come back into the first folder.
  for (const d of v.docs) if (gone.includes(d.folder)) d.folder = v.folders[0].id;
  S.docFolder = f.parent;
  await saveVault();
  render();
});

form("doc", async (v) => {
  const d = S.vault?.docs.find((x) => x.id === v.id);
  if (!d || !v.title.trim()) return;
  d.title = v.title.trim();
  d.folder = v.folder;
  await saveVault();
  closeDialog();
  render();
  toast("Dokument gespeichert.");
});
form("folder", async (v) => {
  const name = v.name.trim();
  if (!name) return void (document.getElementById("form-err")!.textContent = "Bitte geben Sie dem Ordner einen Namen.");
  const list = S.vault!.folders;
  const old = list.find((x) => x.id === v.id);
  if (old) old.name = name;
  else {
    const f = { id: newId(), name, parent: v.parent };
    list.push(f);
    S.docFolder = f.id;
  }
  await saveVault();
  closeDialog();
  render();
});

/** Documents in use, for the start page and the search. */
export const liveDocs = () => (S.vault ? live() : []);

/** Items for "Alle Dokumente exportieren": readable copies in real folders, without the Papierkorb. */
export const exportItems = () => live().map((d) => ({ id: d.id, folders: folderPath(S.vault!.folders, d.folder), file: fileName(d) }));
