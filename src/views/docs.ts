// Dokumente (inside the vault): folders with one level of subfolders.
// On disk every document is one encrypted file; folders exist only in the app.

import type { AddedDoc } from "../backend";
import { ic } from "../icons";
import { DocFolder, DocMeta, fmt, folderPath, newId, parseYmd, ymd } from "../model";
import { S, act, closeDialog, confirmDialog, errorText, esc, form, go, openDialog, render, saveVault, toast } from "../state";

const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", txt: "text/plain" };
const ext = (file: string) => (file.includes(".") ? file.split(".").pop()!.toLowerCase() : "");
const isImage = (file: string) => (MIME[ext(file)] ?? "").startsWith("image/");
const kind = (file: string) => (isImage(file) ? "Foto" : ext(file).toUpperCase() || "Datei");
const size = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");

const children = (id: string) => S.vault!.folders.filter((f) => f.parent === id);
/** A folder's own id plus the ids of its subfolders. */
const subtree = (id: string) => [id, ...children(id).map((f) => f.id)];
const docsIn = (ids: string[]) => S.vault!.docs.filter((d) => ids.includes(d.folder));

function tile(d: DocMeta): string {
  const page = isImage(d.file)
    ? `<div class="page photo"><div class="card"></div><span class="ft">Foto</span></div>`
    : `<div class="page"><div class="ln h"></div>${'<div class="ln"></div>'.repeat(3)}<div class="ln" style="width:70%"></div><div class="ln" style="margin-top:.9rem"></div><div class="ln" style="width:85%"></div><span class="ft">${esc(kind(d.file))}</span></div>`;
  return `<button class="doc" data-act="open-doc" data-id="${d.id}">${page}<span class="t">${esc(d.title)}</span><span class="m">Abgelegt am ${fmt(parseYmd(d.date), { day: "numeric", month: "short", year: "numeric" })}</span></button>`;
}

export function vDocs(): string {
  const v = S.vault!;
  const top = v.folders.filter((f) => !f.parent);
  const cur = v.folders.find((f) => f.id === S.docFolder);
  const item = (f: DocFolder, sub: boolean) =>
    `<li><button class="frow ${sub ? "sub" : ""}" data-act="doc-folder" data-id="${f.id}" ${f.id === S.docFolder ? 'aria-current="true"' : ""}>${ic("folder")}<span>${esc(f.name)}</span><small>${docsIn(sub ? [f.id] : subtree(f.id)).length}</small></button></li>`;
  const tree = `<ul class="ftree"><li><button class="frow" data-act="doc-folder" data-id="" ${!cur ? 'aria-current="true"' : ""}>${ic("doc")}<span>Alle Dokumente</span><small>${v.docs.length}</small></button></li>
    ${top.map((f) => item(f, false) + children(f.id).map((c) => item(c, true)).join("")).join("")}</ul>
    <button class="btn sec" data-act="new-folder" data-parent="" style="width:100%;margin-top:.8rem">${ic("plus")}Neuer Ordner</button>`;

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

  return `<header class="ph"><div><h1>Dokumente</h1><p>Ihre wichtigen Unterlagen, verschlüsselt und nach Ordnern sortiert.</p></div>
  <button class="btn pri big" data-act="add-docs">${ic("plus")}Dokument ablegen</button></header>
  <div class="split docsplit"><nav aria-label="Ordner">${tree}</nav><div>${folderBar}${grid}</div></div>`;
}

const folderOptions = (sel: string) =>
  S.vault!.folders
    .filter((f) => !f.parent)
    .flatMap((f) => [f, ...children(f.id)])
    .map((f) => `<option value="${f.id}" ${f.id === sel ? "selected" : ""}>${esc(folderPath(S.vault!.folders, f.id).join(" › "))}</option>`)
    .join("");

/** Register freshly encrypted files in the document list. */
export async function registerDocs(added: AddedDoc[]) {
  if (!S.vault || !added.length) return;
  const folder = S.docFolder || S.vault.folders[0]?.id || "";
  for (const a of added) S.vault.docs.push({ id: a.id, title: a.name.replace(/\.[^.]+$/, ""), folder, file: a.name, size: a.size, date: ymd(new Date()) });
  await saveVault();
  render();
  toast(added.length === 1 ? `„${added[0].name}“ abgelegt.` : `${added.length} Dokumente abgelegt.`);
}

async function showDoc(d: DocMeta) {
  let url = "";
  let preview = `<p class="empty">Für diesen Dateityp gibt es keine Vorschau. Speichern Sie eine Kopie, um die Datei zu öffnen.</p>`;
  const mime = MIME[ext(d.file)];
  if (mime) {
    try {
      const bytes = await S.backend.docRead(d.id);
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      preview = mime.startsWith("image/") ? `<img class="preview" src="${url}" alt="${esc(d.title)}">` : `<iframe class="preview" src="${url}" title="${esc(d.title)}"></iframe>`;
    } catch (e) {
      preview = `<p class="err">${esc(errorText(e))}</p>`;
    }
  }
  openDialog(
    `<form data-form="doc" novalidate>
    <div class="dh"><div><h2 id="dlg-title">${esc(d.title)}</h2><div class="m">${esc(kind(d.file))}, ${size(d.size)}, abgelegt am ${fmt(parseYmd(d.date), { day: "numeric", month: "long", year: "numeric" })}</div></div><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db">${preview}
      <input type="hidden" name="id" value="${d.id}">
      <div class="two" style="margin-top:1.2rem"><div class="field"><label for="d-title">Name</label><input class="inp" id="d-title" name="title" value="${esc(d.title)}" required></div>
      <div class="field"><label for="d-folder">Ordner</label><select class="inp" id="d-folder" name="folder">${folderOptions(d.folder)}</select></div></div>
    </div>
    <div class="df"><button type="button" class="btn danger left" data-act="delete-doc" data-id="${d.id}">Löschen</button><button type="button" class="btn sec" data-act="export-doc" data-id="${d.id}">${ic("download")}Kopie speichern</button><button class="btn pri" style="--accent:var(--blue)">Speichern</button></div></form>`,
    { wide: true, onClose: () => url && URL.revokeObjectURL(url) },
  );
}

function folderDialog(f: DocFolder, isNew: boolean) {
  openDialog(`<form data-form="folder" novalidate>
    <div class="dh"><h2 id="dlg-title">${isNew ? (f.parent ? "Neuer Unterordner" : "Neuer Ordner") : "Ordner umbenennen"}</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
    <div class="db"><input type="hidden" name="id" value="${isNew ? "" : f.id}"><input type="hidden" name="parent" value="${f.parent}">
      <div class="field"><label for="fo-name">Name${f.parent && isNew ? ` <span class="opt">(in „${esc(S.vault!.folders.find((x) => x.id === f.parent)?.name ?? "")}“)</span>` : ""}</label><input class="inp" id="fo-name" name="name" value="${esc(f.name)}" required autofocus></div>
      <p class="err" id="form-err" role="alert"></p></div>
    <div class="df"><button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--blue)">Speichern</button></div></form>`);
}

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
  const d = S.vault?.docs.find((x) => x.id === el.dataset.id);
  if (!d) return;
  if (S.view !== "docs") go("docs");
  await showDoc(d);
});
act("export-doc", async (el) => {
  const d = S.vault?.docs.find((x) => x.id === el.dataset.id);
  if (!d) return;
  try {
    const e = ext(d.file);
    if (await S.backend.docExport(d.id, e ? `${d.title}.${e}` : d.title)) toast("Kopie gespeichert. Diese Kopie ist nicht verschlüsselt.");
  } catch (err) {
    toast(errorText(err));
  }
});
act("delete-doc", async (el) => {
  const d = S.vault?.docs.find((x) => x.id === el.dataset.id);
  if (!d || !(await confirmDialog(`„${d.title}“ löschen?`, "Das Dokument wird endgültig aus Orga-Neo gelöscht."))) return;
  try {
    await S.backend.docDelete(d.id);
  } catch (err) {
    return toast(errorText(err));
  }
  S.vault!.docs = S.vault!.docs.filter((x) => x.id !== d.id);
  await saveVault();
  closeDialog();
  render();
  toast("Dokument gelöscht.");
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

/** Items for "Alle Dokumente exportieren": readable copies in real folders. */
export const exportItems = () =>
  S.vault!.docs.map((d) => {
    const e = ext(d.file);
    return { id: d.id, folders: folderPath(S.vault!.folders, d.folder), file: e ? `${d.title}.${e}` : d.title };
  });
