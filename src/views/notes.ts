// Notizen: a list on the left, the selected note as a notepad on the right.

import { ic } from "../icons";
import { Note, fmt, newId, parseYmd, ymd } from "../model";
import { S, act, confirmDialog, esc, go, render, saveOpen, toast } from "../state";

const sorted = (list: Note[]) => [...list].sort((a, b) => Number(b.pin) - Number(a.pin) || b.date.localeCompare(a.date));

function listHtml(sel?: Note): string {
  const q = S.search.trim().toLowerCase();
  const list = sorted(S.data.notes.filter((n) => !q || (n.title + " " + n.text).toLowerCase().includes(q)));
  const item = (x: Note) =>
    `<li><button class="row nrow" data-act="select-note" data-id="${x.id}" ${x.id === sel?.id ? 'aria-current="true"' : ""}><span><span class="t">${x.pin ? `<span class="pinmark">${ic("tack")}</span>` : ""}${esc(x.title || "Ohne Titel")}</span><br><span class="m">${esc(x.text.split("\n").find(Boolean) ?? "") || "&nbsp;"}</span></span><span class="end">${fmt(parseYmd(x.date), { day: "numeric", month: "short" })}</span></button></li>`;
  const pinned = list.filter((x) => x.pin);
  const rest = list.filter((x) => !x.pin);
  return `${pinned.length ? `<div class="letter">Angeheftet</div><ul class="rows sel">${pinned.map(item).join("")}</ul>` : ""}
    ${rest.length ? `<div class="letter">${pinned.length ? "Weitere Notizen" : "Notizen"}</div><ul class="rows sel">${rest.map(item).join("")}</ul>` : ""}
    ${!list.length ? `<p class="empty" style="padding:1rem .8rem">Keine Notiz passt zu „${esc(S.search)}“.</p>` : ""}`;
}

export function vNotes(): string {
  const n = S.data.notes.find((x) => x.id === S.noteSel) ?? sorted(S.data.notes)[0];
  const body = S.data.notes.length
    ? `<div class="split notes"><div><label class="search" style="margin-bottom:.4rem;display:block"><span class="sr">Notizen durchsuchen</span>${ic("search")}<input id="q" type="search" placeholder="In Notizen suchen" value="${esc(S.search)}"></label><div id="note-list">${listHtml(n)}</div></div>
      ${n ? `<article class="paper">
        <input class="ntitle" id="note-title" data-id="${n.id}" value="${esc(n.title)}" placeholder="Titel" aria-label="Titel der Notiz">
        <div class="nmeta" id="note-meta">Zuletzt geändert am ${fmt(parseYmd(n.date), { day: "numeric", month: "long", year: "numeric" })}</div>
        <textarea class="ntext" id="note-text" data-id="${n.id}" placeholder="Hier schreiben …" aria-label="Text der Notiz">${esc(n.text)}</textarea>
        <div class="det-f"><button class="btn sec" data-act="pin-note" data-id="${n.id}">${ic("tack")}${n.pin ? "Nicht mehr anheften" : "Auf der Startseite anheften"}</button><button class="btn ghost" data-act="delete-note" data-id="${n.id}">Löschen</button></div>
      </article>` : ""}</div>`
    : `<div class="blank">${ic("note")}<h2>Noch keine Notizen</h2><p>Einkaufsliste, Fragen an den Arzt, Zählerstände: alles, was Sie sich merken möchten.</p><button class="btn pri big" data-act="new-note">${ic("plus")}Erste Notiz schreiben</button></div>`;
  return `<header class="ph"><div><h1>Notizen</h1><p>Alles, was Sie sich merken möchten. Wird beim Schreiben gespeichert.</p></div>
  <button class="btn pri big" data-act="new-note">${ic("plus")}Neue Notiz</button></header>${body}`;
}

/** Called on every keystroke in the notepad: keep the model in step without redrawing the editor. */
export function noteInput(el: HTMLInputElement | HTMLTextAreaElement) {
  const n = S.data.notes.find((x) => x.id === el.dataset.id);
  if (!n) return;
  if (el.id === "note-title") n.title = el.value;
  else n.text = el.value;
  n.date = ymd(new Date());
  saveOpen();
  const list = document.getElementById("note-list");
  if (list) list.innerHTML = listHtml(n);
}

act("select-note", (el) => {
  S.noteSel = el.dataset.id!;
  render();
});
act("open-note", (el) => {
  S.noteSel = el.dataset.id!;
  go("notes");
});
act("new-note", () => {
  const n: Note = { id: newId(), title: "", text: "", pin: false, date: ymd(new Date()) };
  S.data.notes.push(n);
  S.noteSel = n.id;
  S.search = "";
  saveOpen();
  render();
  document.getElementById("note-title")?.focus();
});
act("pin-note", (el) => {
  const n = S.data.notes.find((x) => x.id === el.dataset.id);
  if (!n) return;
  n.pin = !n.pin;
  saveOpen();
  render();
});
act("delete-note", async (el) => {
  const n = S.data.notes.find((x) => x.id === el.dataset.id);
  if (!n || !(await confirmDialog(`„${n.title || "Ohne Titel"}“ löschen?`, "Die Notiz wird endgültig gelöscht."))) return;
  S.data.notes = S.data.notes.filter((x) => x.id !== n.id);
  S.noteSel = "";
  saveOpen();
  render();
  toast("Notiz gelöscht.");
});
