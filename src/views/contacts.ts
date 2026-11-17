// Kontakte: people with phone numbers, addresses and birthdays.

import { ic } from "../icons";
import { Contact, addDays, ageOn, fmt, initials, newId, occurrences, parseYmd, relLower, sortName, startOfDay } from "../model";
import { S, act, closeDialog, confirmDialog, esc, form, go, openDialog, render, saveOpen, toast } from "../state";

export function vContacts(): string {
  const q = S.search.trim().toLowerCase();
  const list = S.data.contacts
    .filter((c) => !q || [c.name, c.rel, c.city, c.mobile, c.phone].join(" ").toLowerCase().includes(q))
    .sort((a, b) => sortName(a).localeCompare(sortName(b), "de"));
  const c = list.find((x) => x.id === S.contactSel) ?? list[0];

  let rows = "";
  let last = "";
  for (const x of list) {
    const letter = (sortName(x)[0] ?? "#").toUpperCase();
    if (letter !== last) {
      rows += `<li class="letter" aria-hidden="true">${esc(letter)}</li>`;
      last = letter;
    }
    rows += `<li><button class="row" data-act="select-contact" data-id="${esc(x.id)}" ${x.id === c?.id ? 'aria-current="true"' : ""}><span class="av">${esc(initials(x.name))}</span><span><span class="t">${esc(x.name)}</span><br><span class="m">${esc(x.rel) || "&nbsp;"}</span></span></button></li>`;
  }

  let detail = "";
  if (c) {
    const now = new Date();
    const next = c.bday ? occurrences([], [c], startOfDay(now), addDays(now, 366))[0] : undefined;
    const kv = (icon: string, label: string, value: string, cls = "") =>
      value ? `<div class="kv"><span class="k">${ic(icon)}${label}</span><span class="v ${cls}">${value}</span></div>` : "";
    detail = `<article class="detail" aria-label="${esc(c.name)}">
      <div class="det-h"><span class="av big">${esc(initials(c.name))}</span><div><h2>${esc(c.name)}</h2>${c.rel ? `<p>${esc(c.rel)}</p>` : ""}</div></div>
      ${kv("phone", "Handy", esc(c.mobile), "tel")}${kv("phone", "Telefon", esc(c.phone), "tel")}
      ${kv("pin", "Adresse", [c.street, c.city].filter(Boolean).map(esc).join("<br>"))}
      ${kv("mail", "E-Mail", esc(c.mail))}
      ${kv("cake", "Geburtstag", c.bday ? fmt(parseYmd(c.bday), { day: "numeric", month: "long", year: "numeric" }) + (next ? `<br><span class="soft">wird ${ageOn(c, next.date)} ${relLower(next.date, now) || "am " + fmt(next.date, { day: "numeric", month: "long" })}</span>` : "") : "")}
      ${kv("note", "Notiz", esc(c.note))}
      <div class="det-f"><button class="btn sec" data-act="edit-contact" data-id="${esc(c.id)}">Bearbeiten</button><button class="btn ghost" data-act="delete-contact" data-id="${esc(c.id)}">Löschen</button></div>
    </article>`;
  }

  const body = S.data.contacts.length
    ? `<div class="split"><div><label class="search" style="margin-bottom:1rem;display:block"><span class="sr">Kontakte durchsuchen</span>${ic("search")}<input id="q" type="search" placeholder="Name suchen" value="${esc(S.search)}"></label>
      <ul class="rows sel">${rows || `<li><p class="empty" style="padding:1rem .8rem">Niemand passt zu „${esc(S.search)}“.</p></li>`}</ul></div>${detail}</div>`
    : `<div class="blank">${ic("person")}<h2>Noch keine Kontakte</h2><p>Tragen Sie Familie, Freunde, Ärzte und wichtige Nummern ein. Geburtstage erscheinen automatisch im Kalender.</p><button class="btn pri big" data-act="new-contact">${ic("plus")}Erste Person hinzufügen</button></div>`;

  return `<header class="ph"><div><h1>Kontakte</h1><p>Telefonnummern, Anschriften und Geburtstage.</p></div>
  <button class="btn pri big" data-act="new-contact">${ic("plus")}Person hinzufügen</button></header>${body}`;
}

function contactDialog(c: Contact, isNew: boolean, short = false) {
  const f = (name: keyof Contact, label: string, extra = "") =>
    `<div class="field"><label for="c-${name}">${label}</label><input class="inp" id="c-${name}" name="${name}" value="${esc(c[name])}" ${extra}></div>`;
  openDialog(`<form data-form="contact" novalidate>
  <div class="dh"><h2 id="dlg-title">${short ? "Geburtstag eintragen" : isNew ? "Person hinzufügen" : "Kontakt ändern"}</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
  <div class="db">
    <input type="hidden" name="id" value="${isNew ? "" : esc(c.id)}">
    ${f("name", "Name", 'required autofocus placeholder="Vorname Nachname"')}
    ${short ? `${f("bday", "Geburtstag", 'type="date" required')}<p class="hint-line">Die Person wird in Ihren Kontakten angelegt. Telefon und Adresse können Sie dort später ergänzen.</p>` : `
    ${f("rel", "Wer ist das? <span class=\"opt\">(z. B. Tochter, Hausarzt)</span>")}
    <div class="two">${f("mobile", "Handy", 'type="tel"')}${f("phone", "Telefon", 'type="tel"')}</div>
    <div class="two">${f("street", "Straße und Hausnummer")}${f("city", "PLZ und Ort")}</div>
    <div class="two">${f("mail", "E-Mail", 'type="email"')}${f("bday", "Geburtstag", 'type="date"')}</div>
    ${f("note", "Notiz")}`}
    <p class="err" id="form-err" role="alert"></p>
  </div>
  <div class="df"><button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--petrol)">Speichern</button></div></form>`);
}

const blank = (): Contact => ({ id: "", name: "", rel: "", mobile: "", phone: "", street: "", city: "", mail: "", bday: "", note: "" });

act("select-contact", (el) => {
  S.contactSel = el.dataset.id!;
  render();
});
act("open-contact", (el) => {
  S.contactSel = el.dataset.id!;
  go("addr");
});
act("new-contact", () => contactDialog(blank(), true));
act("new-birthday", () => contactDialog(blank(), true, true));
act("edit-contact", (el) => {
  const c = S.data.contacts.find((x) => x.id === el.dataset.id);
  if (c) contactDialog(c, false);
});
act("delete-contact", async (el) => {
  const c = S.data.contacts.find((x) => x.id === el.dataset.id);
  if (!c || !(await confirmDialog(`${c.name} löschen?`, "Der Kontakt und sein Geburtstag im Kalender werden endgültig gelöscht."))) return;
  S.data.contacts = S.data.contacts.filter((x) => x.id !== c.id);
  S.contactSel = "";
  saveOpen();
  render();
  toast("Kontakt gelöscht.");
});

form("contact", (v) => {
  const name = v.name.trim();
  if (!name) return void (document.getElementById("form-err")!.textContent = "Bitte tragen Sie einen Namen ein.");
  const old = S.data.contacts.find((x) => x.id === v.id);
  const c: Contact = { ...(old ?? blank()), id: v.id || newId() };
  for (const k of ["name", "rel", "mobile", "phone", "street", "city", "mail", "bday", "note"] as const) if (k in v) c[k] = v[k].trim();
  if (old) S.data.contacts[S.data.contacts.indexOf(old)] = c;
  else S.data.contacts.push(c);
  S.contactSel = c.id;
  saveOpen();
  closeDialog();
  if (S.view === "addr" || S.view === "cal") render();
  else go("addr");
  toast("Kontakt gespeichert.");
});
