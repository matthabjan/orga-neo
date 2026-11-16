// Termine: month view, day panel, categories, appointment form.

import { ic } from "../icons";
import { BDAY_CAT, CAT_COLORS, Ev, Repeat, addDays, ageOn, fmt, newId, occurrences, parseYmd, relDay, startOfDay, ymd } from "../model";
import { S, act, closeDialog, confirmDialog, esc, form, go, openDialog, render, saveOpen, toast } from "../state";

const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const REPEATS: [Repeat, string][] = [["", "Nie"], ["weekly", "Jede Woche"], ["monthly", "Jeden Monat"], ["yearly", "Jedes Jahr"]];
const REMINDERS: [number, string][] = [[-1, "Nicht erinnern"], [0, "Zur Uhrzeit"], [60, "1 Stunde vorher"], [1440, "1 Tag vorher"], [2880, "2 Tage vorher"]];
const REP_TEXT: Record<string, string> = { weekly: "jede Woche", monthly: "jeden Monat", yearly: "jedes Jahr" };

export const category = (id: string) => S.data.settings.categories.find((c) => c.id === id);

/** Inline style for a category: "pill" (tinted), "dot" or "solid". */
export function catStyle(id: string, kind: "pill" | "dot" | "solid"): string {
  const col = CAT_COLORS[category(id)?.color ?? "slate"] ?? CAT_COLORS.slate;
  if (kind === "pill") return `background:${col.t};color:${col.ink};border-left:4px solid ${col.c}`;
  if (kind === "dot") return `background:${col.c}`;
  return `background:${col.c};color:#fff`;
}

export function vCal(): string {
  const now = new Date();
  const m = S.calMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7);
  const end = addDays(start, weeks * 7 - 1);
  const all = occurrences(S.data.events, S.data.contacts, start, end).filter((o) => !S.calHidden.has(o.ev.cat));
  const by: Record<string, typeof all> = {};
  for (const o of all) (by[ymd(o.date)] ??= []).push(o);
  const today = ymd(now);

  let cells = "";
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const k = ymd(d);
    const evs = by[k] ?? [];
    cells += `<button class="day ${d.getMonth() !== m.getMonth() ? "out" : ""} ${k === today ? "today" : ""}" data-act="cal-day" data-day="${k}" aria-pressed="${k === S.calSel}" aria-label="${fmt(d, { weekday: "long", day: "numeric", month: "long" })}${evs.length ? `, ${evs.length} ${evs.length > 1 ? "Termine" : "Termin"}` : ""}">
      <span class="dn">${d.getDate()}</span>${evs.slice(0, 2).map((o) => `<span class="pill" style="${catStyle(o.ev.cat, "pill")}">${esc(o.contact ? "Geb. " + o.contact.name.split(" ")[0] : o.ev.title)}</span>`).join("")}${evs.length > 2 ? `<span class="more">+${evs.length - 2} weitere</span>` : ""}</button>`;
  }

  const sel = parseYmd(S.calSel);
  const selEvs = occurrences(S.data.events, S.data.contacts, sel, sel).filter((o) => !S.calHidden.has(o.ev.cat));
  const rel = relDay(sel, now);
  const list = selEvs
    .map((o) => {
      const cat = category(o.ev.cat);
      if (o.contact)
        return `<li><button class="dl-b" data-act="open-contact" data-id="${o.contact.id}"><span class="cattag" style="${catStyle(o.ev.cat, "pill")}">${esc(cat?.name ?? "")}</span>
          <span class="ev-t">${esc(o.contact.name)}</span><span class="ev-m">wird ${ageOn(o.contact, o.date)} Jahre alt</span></button></li>`;
      const e = o.ev;
      return `<li><button class="dl-b" data-act="edit-event" data-id="${e.id}"><span class="cattag" style="${catStyle(e.cat, "pill")}">${esc(cat?.name ?? "")}</span>
        <span class="tm">${e.time ? e.time + " Uhr" : "Ganztägig"}</span><span class="ev-t">${esc(e.title)}</span>
        ${e.place ? `<span class="ev-m">${esc(e.place)}</span>` : ""}${e.note ? `<span class="ev-m">${esc(e.note)}</span>` : ""}
        ${e.rep ? `<span class="rep">${ic("repeat")}Wiederholt sich ${REP_TEXT[e.rep]}</span>` : ""}${e.rem >= 0 ? `<span class="rep">${ic("bell")}Erinnerung: ${REMINDERS.find((r) => r[0] === e.rem)?.[1].toLowerCase() ?? e.rem + " Minuten vorher"}</span>` : ""}</button></li>`;
    })
    .join("");

  const filter = S.data.settings.categories
    .map((c) => `<button class="chip cat" data-act="cal-filter" data-id="${c.id}" aria-pressed="${!S.calHidden.has(c.id)}"><span class="dot" style="${catStyle(c.id, "dot")}"></span>${esc(c.name)}</button>`)
    .join("");

  return `<header class="ph"><div><h1>Termine</h1><p>Wählen Sie einen Tag, um seine Termine zu sehen. Zum Ändern klicken Sie auf den Termin.</p></div>
  <button class="btn pri big" data-act="new-event">${ic("plus")}Termin eintragen</button></header>
  <div class="chips" role="group" aria-label="Kategorien ein- und ausblenden">${filter}</div>
  <div class="cal-wrap">
    <section>
      <div class="cal-head"><h2>${fmt(m, { month: "long", year: "numeric" })}</h2>
        <button class="btn sec" data-act="cal-today">Heute</button>
        <button class="iconbtn" data-act="cal-move" data-by="-1" aria-label="Vorheriger Monat">${ic("left")}</button>
        <button class="iconbtn" data-act="cal-move" data-by="1" aria-label="Nächster Monat">${ic("right")}</button></div>
      <div class="cal">${WD.map((w) => `<div class="wdh">${w}</div>`).join("")}${cells}</div>
    </section>
    <aside class="dayp" aria-live="polite">
      <h3>${fmt(sel, { weekday: "long", day: "numeric", month: "long" })}</h3>
      <p class="sub">${rel || fmt(sel, { year: "numeric" })}</p>
      ${list ? `<ul class="dlist">${list}</ul>` : `<p class="empty">An diesem Tag ist nichts eingetragen.</p>`}
      <button class="btn sec" data-act="new-event" style="width:100%">${ic("plus")}Termin an diesem Tag</button>
    </aside>
  </div>`;
}

function eventDialog(e: Ev, isNew: boolean) {
  const cats = S.data.settings.categories.filter((c) => c.id !== BDAY_CAT);
  const opt = <T,>(list: [T, string][], cur: T) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
  openDialog(`<form data-form="event" novalidate>
  <div class="dh"><h2 id="dlg-title">${isNew ? "Termin eintragen" : "Termin ändern"}</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
  <div class="db">
    <input type="hidden" name="id" value="${isNew ? "" : e.id}">
    <div class="field"><label for="f-t">Was?</label><input class="inp" id="f-t" name="title" placeholder="z. B. Zahnarzt" value="${esc(e.title)}" required autofocus></div>
    <div class="two"><div class="field"><label for="f-d">Datum</label><input class="inp" id="f-d" name="date" type="date" value="${e.date}" required></div>
    <div class="field"><label for="f-z">Uhrzeit</label><input class="inp" id="f-z" name="time" type="time" value="${e.time}"><div class="hint">Leer lassen für ganztägig</div></div></div>
    <div class="two"><div class="field"><label for="f-c">Kategorie</label><select class="inp" id="f-c" name="cat">${cats.map((c) => `<option value="${c.id}" ${c.id === e.cat ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
    <div class="field"><label for="f-o">Wo? <span class="opt">(freiwillig)</span></label><input class="inp" id="f-o" name="place" placeholder="Adresse oder Ort" value="${esc(e.place)}"></div></div>
    <div class="two"><div class="field"><label for="f-r">Wiederholen</label><select class="inp" id="f-r" name="rep">${opt(REPEATS, e.rep)}</select></div>
    <div class="field"><label for="f-e">Erinnern</label><select class="inp" id="f-e" name="rem">${opt(REMINDERS, e.rem)}</select></div></div>
    <div class="field"><label for="f-n">Notiz <span class="opt">(freiwillig)</span></label><input class="inp" id="f-n" name="note" value="${esc(e.note)}"></div>
    ${isNew ? `<p class="hint-line">${ic("cake")}Einen Geburtstag? <button type="button" class="linkbtn" data-act="new-birthday">Geburtstag eintragen</button></p>` : ""}
    <p class="err" id="form-err" role="alert"></p>
  </div>
  <div class="df">${isNew ? "" : `<button type="button" class="btn danger left" data-act="delete-event" data-id="${e.id}">Löschen</button>`}<button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--plum)">Termin speichern</button></div></form>`);
}

act("cal-day", (el) => {
  S.calSel = el.dataset.day!;
  const d = parseYmd(S.calSel);
  if (d.getMonth() !== S.calMonth.getMonth()) S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  render();
});
act("cal-move", (el) => {
  S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + Number(el.dataset.by), 1);
  render();
});
act("cal-today", () => {
  const t = startOfDay(new Date());
  S.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  S.calSel = ymd(t);
  render();
});
act("cal-filter", (el) => {
  const id = el.dataset.id!;
  if (S.calHidden.has(id)) S.calHidden.delete(id);
  else S.calHidden.add(id);
  render();
});
act("new-event", () => {
  const cat = S.data.settings.categories.find((c) => c.id !== BDAY_CAT)?.id ?? "";
  const date = S.view === "cal" ? S.calSel : ymd(new Date());
  eventDialog({ id: "", title: "", date, time: "", place: "", note: "", rep: "", rem: 1440, cat }, true);
});
act("edit-event", (el) => {
  const e = S.data.events.find((x) => x.id === el.dataset.id);
  if (e) eventDialog(e, false);
});
act("delete-event", async (el) => {
  const e = S.data.events.find((x) => x.id === el.dataset.id);
  if (!e) return;
  const text = e.rep ? "Der Termin wiederholt sich. Alle Wiederholungen werden gelöscht." : "Der Termin wird endgültig gelöscht.";
  if (!(await confirmDialog(`„${e.title}“ löschen?`, text))) return;
  S.data.events = S.data.events.filter((x) => x.id !== e.id);
  saveOpen();
  closeDialog();
  render();
  toast("Termin gelöscht.");
});

form("event", (v) => {
  const title = v.title.trim();
  const err = document.getElementById("form-err")!;
  if (!title) return void (err.textContent = "Bitte tragen Sie ein, worum es geht.");
  if (!v.date) return void (err.textContent = "Bitte wählen Sie ein Datum.");
  const e: Ev = { id: v.id || newId(), title, date: v.date, time: v.time, place: v.place.trim(), note: v.note.trim(), rep: v.rep as Repeat, rem: Number(v.rem), cat: v.cat };
  const i = S.data.events.findIndex((x) => x.id === e.id);
  if (i >= 0) {
    S.data.events[i] = e;
    // a changed appointment may remind again
    for (const k of Object.keys(S.data.done)) if (k.startsWith(e.id + "@")) delete S.data.done[k];
  } else S.data.events.push(e);
  saveOpen();
  S.calSel = e.date;
  S.calMonth = new Date(parseYmd(e.date).getFullYear(), parseYmd(e.date).getMonth(), 1);
  closeDialog();
  if (S.view !== "cal" && S.view !== "home") go("cal");
  else render();
  toast("Termin gespeichert.");
});
