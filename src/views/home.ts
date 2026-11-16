// Top bar and start page.

import { ic } from "../icons";
import { AreaId, addDays, ageOn, fmt, initials, occurrences, relDay, relLower, startOfDay } from "../model";
import { AREAS, S, act, appName, esc, go, render } from "../state";
import { catStyle } from "./cal";
import { vUpdateBanner } from "./update";
import { lockVault } from "./vault";

export function shell(inner: string): string {
  return `<div class="app hub">
  <header class="hubbar">
    <div class="brand"><span class="rings" aria-hidden="true"><i></i><i></i><i></i></span>${esc(appName())}</div>
    ${S.view !== "home" ? `<button class="back" data-act="go" data-view="home">${ic("left")}Zur Startseite</button>` : ""}
    <span class="hubsp"></span>
    <span class="saved ${S.saved ? "" : "busy"}" id="saved">${S.saved ? "Alles gespeichert" : "Wird gespeichert …"}</span>
    ${S.vault ? `<button class="plain" data-act="lock-vault" title="Passwörter und Dokumente wieder verschließen">${ic("lock")}Tresor schließen</button>` : ""}
    <button class="plain" data-act="go" data-view="settings" ${S.view === "settings" ? 'aria-current="page"' : ""}>${ic("gear")}Einstellungen</button>
  </header>
  ${vUpdateBanner()}
  <main class="sheet" id="main" tabindex="-1">${inner}</main></div>`;
}

function tileInfo(id: AreaId, now: Date): string {
  const d = S.data;
  if (id === "cal") {
    const next = occurrences(d.events, [], now, addDays(now, 30)).find((o) => relDay(o.date, now) !== "Heute");
    if (!next) return "Keine Termine in Sicht";
    return `${relDay(next.date, now) || fmt(next.date, { day: "numeric", month: "short" })}: ${esc(next.ev.title)}`;
  }
  if (id === "addr") return d.contacts.length === 1 ? "1 Person" : `${d.contacts.length} Personen`;
  if (id === "notes") {
    const pins = d.notes.filter((n) => n.pin).length;
    return pins ? `${d.notes.length} Notizen, ${pins} angeheftet` : `${d.notes.length} Notizen`;
  }
  if (!S.vault) return `${ic("lock")}Verschlossen`;
  return id === "docs" ? `${S.vault.docs.length} Unterlagen` : `${S.vault.passwords.length} gespeichert`;
}

function searchResults(q: string): string {
  const has = (...parts: string[]) => parts.join(" ").toLowerCase().includes(q);
  const d = S.data;
  const groups: string[] = [];
  const row = (attrs: string, color: string, avatar: string, title: string, sub: string) =>
    `<li><button class="row" ${attrs}><span class="av" style="background:var(--${color}-t);color:var(--${color})">${avatar}</span><span><span class="t">${esc(title)}</span><br><span class="m">${esc(sub) || "&nbsp;"}</span></span></button></li>`;
  const group = (title: string, rows: string[]) => {
    if (rows.length) groups.push(`<h2>${title}</h2><ul class="rows">${rows.join("")}</ul>`);
  };
  group("Termine", d.events.filter((e) => has(e.title, e.place, e.note)).map((e) => row(`data-act="edit-event" data-id="${e.id}"`, "plum", ic("cal"), e.title, fmt(new Date(e.date + "T00:00"), { day: "numeric", month: "long", year: "numeric" }) + (e.time ? `, ${e.time} Uhr` : ""))));
  group("Kontakte", d.contacts.filter((c) => has(c.name, c.rel, c.street, c.city, c.mobile, c.phone, c.note)).map((c) => row(`data-act="open-contact" data-id="${c.id}"`, "petrol", esc(initials(c.name)), c.name, c.mobile || c.phone || c.rel)));
  group("Notizen", d.notes.filter((n) => has(n.title, n.text)).map((n) => row(`data-act="open-note" data-id="${n.id}"`, "mustard", ic("note"), n.title || "Ohne Titel", n.text.split("\n")[0])));
  if (S.vault) {
    group("Dokumente", S.vault.docs.filter((x) => has(x.title, x.file)).map((x) => row(`data-act="open-doc" data-id="${x.id}"`, "blue", ic("doc"), x.title, x.file)));
    group("Passwörter", S.vault.passwords.filter((p) => has(p.name, p.site, p.user)).map((p) => row(`data-act="open-pw" data-id="${p.id}"`, "green", esc(p.name[0] ?? "?"), p.name, p.user)));
  }
  const hint = S.vault ? "" : `<p class="hint-line">${ic("lock")}Passwörter und Dokumente werden erst durchsucht, wenn der Tresor geöffnet ist.</p>`;
  if (!groups.length) return `<p class="empty">Nichts gefunden für „${esc(S.search)}“. Versuchen Sie ein anderes Wort.</p>${hint}`;
  return `<section class="results" aria-label="Suchergebnisse">${groups.join("")}</section>${hint}`;
}

export function vHome(): string {
  const now = new Date();
  const s = S.data.settings;
  const h = now.getHours();
  const hello = h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
  const today = startOfDay(now);
  const q = S.search.trim().toLowerCase();

  const head = `<header class="today">
    <div>
      <p class="greet">${hello}${s.firstName ? ", " + esc(s.firstName) : ""}.</p>
      <p class="wd">${fmt(now, { weekday: "long" })}</p>
      <h1 class="date">${fmt(now, { day: "numeric", month: "long", year: "numeric" })}</h1>
    </div>
    <label class="search"><span class="sr">In allem suchen</span>${ic("search")}<input id="q" type="search" placeholder="In allem suchen, z. B. „Zahnarzt“" value="${esc(S.search)}"></label>
  </header>`;
  if (q) return head + searchResults(q);

  const tiles = s.tiles.length
    ? `<div class="tiles" style="--n:${s.tiles.length}">${s.tiles
        .map((id) => `<button class="tile" style="--c:${AREAS[id].c}" data-act="go" data-view="${id}">${ic(AREAS[id].icon)}<span><b>${AREAS[id].label}</b><span>${tileInfo(id, now)}</span></span></button>`)
        .join("")}</div>`
    : "";

  const upcoming = occurrences(S.data.events, [], today, addDays(today, 21)).slice(0, 5);
  const next = !s.showNext
    ? ""
    : `<section><h2>Als Nächstes</h2>${
        upcoming.length
          ? `<ul class="agenda">${upcoming
              .map(({ ev, date }) => {
                const r = relDay(date, now);
                return `<li><div class="dbox ${r === "Heute" ? "now" : ""}"><b>${date.getDate()}</b><span>${fmt(date, { month: "short" }).replace(".", "")}</span></div>
                <button class="agenda-b" data-act="edit-event" data-id="${ev.id}"><span class="ev-t">${esc(ev.title)}${r ? `<span class="when-rel">${r}</span>` : ""}</span>
                <span class="ev-m">${fmt(date, { weekday: "long" })}${ev.time ? `, ${ev.time} Uhr` : ", ganztägig"}${ev.place ? `<br>${esc(ev.place)}` : ""}</span>
                <span class="catdot" style="${catStyle(ev.cat, "dot")}"></span></button></li>`;
              })
              .join("")}</ul>`
          : `<p class="empty">In den nächsten drei Wochen steht nichts an.</p>`
      }<button class="btn sec" data-act="new-event" style="margin-top:1rem">${ic("plus")}Termin eintragen</button></section>`;

  const bdays = occurrences([], S.data.contacts, today, addDays(today, 45)).slice(0, 4);
  const birthdays =
    !s.showBirthdays || !bdays.length
      ? ""
      : `<h2>Geburtstage</h2><ul class="bdays">${bdays
          .map(({ contact, date }) => {
            const r = relDay(date, now);
            return `<li><button class="bday-b" data-act="open-contact" data-id="${contact!.id}"><span class="bd-ic">${ic("cake")}</span><span><span class="ev-t">${esc(contact!.name)}</span><br><span class="ev-m">wird ${ageOn(contact!, date)}, ${r ? relLower(date, now) : "am " + fmt(date, { day: "numeric", month: "long" })}</span></span></button></li>`;
          })
          .join("")}</ul>`;

  const pins = S.data.notes.filter((n) => n.pin);
  const pinned =
    !s.showPinned || !pins.length
      ? ""
      : `<h2 ${birthdays ? 'style="margin-top:2rem"' : ""}>Angeheftete Notizen</h2><div class="pins">${pins
          .map((n) => `<button class="pinnote" data-act="open-note" data-id="${n.id}"><b>${esc(n.title || "Ohne Titel")}</b><span>${esc(n.text.split("\n").map((l) => l.replace(/^[-•]\s*/, "")).filter(Boolean).slice(0, 2).join("\n"))}</span></button>`)
          .join("")}</div>`;

  const side = birthdays || pinned ? `<section>${birthdays}${pinned}</section>` : "";
  return `${head}${tiles}<div class="ov ${side && next ? "" : "one"}">${next}${side}</div>`;
}

act("go", (el) => go(el.dataset.view as never));
act("lock-vault", async () => {
  await lockVault();
  render();
});
