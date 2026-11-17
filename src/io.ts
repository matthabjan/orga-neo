// Import and export in standard formats:
// appointments .ics, contacts .vcf, passwords .csv, notes .txt/.md

import { Contact, Ev, Note, Pw, Repeat, newId, ymd } from "./model";

// ---------- shared ----------

/** RFC 5545 / 6350 line unfolding: a line starting with space or tab continues the previous one. */
function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((l) => l.trim() !== "");
}

function parseLine(line: string): { name: string; params: string[]; value: string } {
  const i = line.indexOf(":");
  const head = i < 0 ? line : line.slice(0, i);
  const [name, ...params] = head.split(";");
  return { name: name.replace(/^.*\./, "").toUpperCase(), params: params.map((p) => p.toUpperCase()), value: i < 0 ? "" : line.slice(i + 1) };
}

const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Fold lines longer than 75 bytes as the standards ask. */
function fold(line: string): string {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) parts.push(" " + line.slice(i, i + 73));
  return parts.join("\r\n");
}

/** 20261117 or 2026-11-17 (optionally with a time part) -> 2026-11-17 */
function toYmd(v: string): string {
  const m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// ---------- appointments: iCalendar ----------

const FREQ: Record<string, Repeat> = { WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };

export function parseIcs(text: string, defaultCat: string): Ev[] {
  const out: Ev[] = [];
  let cur: Ev | null = null;
  let inAlarm = false;
  for (const line of unfold(text)) {
    const { name, params, value } = parseLine(line);
    if (name === "BEGIN" && value.toUpperCase() === "VEVENT") {
      cur = { id: newId(), title: "", date: "", time: "", place: "", note: "", rep: "", rem: -1, cat: defaultCat };
    } else if (name === "END" && value.toUpperCase() === "VEVENT") {
      if (cur && cur.date) out.push({ ...cur, title: cur.title || "Termin" });
      cur = null;
    } else if (name === "BEGIN" && value.toUpperCase() === "VALARM") {
      inAlarm = true;
    } else if (name === "END" && value.toUpperCase() === "VALARM") {
      inAlarm = false;
    } else if (cur && inAlarm) {
      // TRIGGER:-PT30M / -P1D / -PT1H
      const m = name === "TRIGGER" && value.match(/^-P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
      if (m) cur.rem = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
    } else if (cur) {
      if (name === "SUMMARY") cur.title = unescapeText(value);
      else if (name === "LOCATION") cur.place = unescapeText(value);
      else if (name === "DESCRIPTION") cur.note = unescapeText(value);
      else if (name === "DTSTART") {
        const allDay = params.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        if (allDay) cur.date = toYmd(value);
        else {
          const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
          if (m) {
            // "Z" means UTC: convert to local time. Otherwise take the wall-clock time as written.
            const d = m[7]
              ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
              : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
            cur.date = ymd(d);
            cur.time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          }
        }
      } else if (name === "RRULE") {
        const f = value.match(/FREQ=([A-Z]+)/i)?.[1]?.toUpperCase() ?? "";
        const interval = +(value.match(/INTERVAL=(\d+)/i)?.[1] ?? 1);
        if (interval === 1) cur.rep = FREQ[f] ?? "";
      }
    }
  }
  return out;
}

export function toIcs(events: Ev[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Orga-Neo//DE", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    const d = e.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@orga-neo`, `DTSTAMP:${stamp}`);
    if (e.time) lines.push(`DTSTART:${d}T${e.time.replace(":", "")}00`);
    else lines.push(`DTSTART;VALUE=DATE:${d}`);
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.place) lines.push(`LOCATION:${escapeText(e.place)}`);
    if (e.note) lines.push(`DESCRIPTION:${escapeText(e.note)}`);
    if (e.rep) lines.push(`RRULE:FREQ=${e.rep.toUpperCase()}`);
    if (e.rem >= 0) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:-PT${e.rem}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------- contacts: vCard ----------

export function parseVcf(text: string): Contact[] {
  const out: Contact[] = [];
  let cur: Contact | null = null;
  let nName = "";
  for (const line of unfold(text)) {
    const { name, params, value } = parseLine(line);
    if (name === "BEGIN" && value.toUpperCase() === "VCARD") {
      cur = { id: newId(), name: "", rel: "", mobile: "", phone: "", street: "", city: "", mail: "", bday: "", note: "" };
      nName = "";
    } else if (name === "END" && value.toUpperCase() === "VCARD") {
      if (cur) {
        cur.name = cur.name || nName;
        if (cur.name) out.push(cur);
      }
      cur = null;
    } else if (cur) {
      const p = params.join(";");
      if (name === "FN") cur.name = unescapeText(value);
      else if (name === "N") {
        const [last = "", first = "", , prefix = ""] = value.split(";").map(unescapeText);
        nName = [prefix, first, last].filter(Boolean).join(" ");
      } else if (name === "TEL") {
        const num = value.replace(/^tel:/i, "");
        if (/CELL|MOBILE/.test(p) && !cur.mobile) cur.mobile = num;
        else if (!cur.phone) cur.phone = num;
        else if (!cur.mobile) cur.mobile = num;
      } else if (name === "EMAIL" && !cur.mail) cur.mail = value;
      else if (name === "ADR" && !cur.street) {
        const a = value.split(";").map(unescapeText);
        cur.street = a[2] ?? "";
        cur.city = [a[5], a[3]].filter(Boolean).join(" ");
      } else if (name === "BDAY") cur.bday = toYmd(value);
      else if (name === "NOTE") cur.note = unescapeText(value);
      else if ((name === "ROLE" || name === "TITLE" || name === "ORG") && !cur.rel) cur.rel = unescapeText(value).replace(/;+$/, "");
    }
  }
  return out;
}

export function toVcf(contacts: Contact[]): string {
  const lines: string[] = [];
  for (const c of contacts) {
    const m = c.city.match(/^(\d{4,5})\s+(.*)$/);
    lines.push("BEGIN:VCARD", "VERSION:3.0", `FN:${escapeText(c.name)}`, `N:${escapeText(c.name)};;;;`);
    if (c.mobile) lines.push(`TEL;TYPE=CELL:${c.mobile}`);
    if (c.phone) lines.push(`TEL;TYPE=HOME:${c.phone}`);
    if (c.mail) lines.push(`EMAIL:${c.mail}`);
    if (c.street || c.city) lines.push(`ADR;TYPE=HOME:;;${escapeText(c.street)};${escapeText(m ? m[2] : c.city)};;${m ? m[1] : ""};`);
    if (c.bday) lines.push(`BDAY:${c.bday}`);
    if (c.rel) lines.push(`ROLE:${escapeText(c.rel)}`);
    if (c.note) lines.push(`NOTE:${escapeText(c.note)}`);
    lines.push("END:VCARD");
  }
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------- passwords: CSV ----------

/** RFC 4180 parser: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string, sep = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

// Column names used by Edge/Chrome, Firefox, Bitwarden, KeePass(XC) and 1Password exports.
const COLS = {
  name: ["name", "title", "account"],
  site: ["url", "login_uri", "website", "web site", "origin"],
  user: ["username", "login_username", "user name", "login name", "user"],
  pw: ["password", "login_password"],
  note: ["note", "notes", "comments", "extra"],
};

export function parsePasswordCsv(text: string): Pw[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const idx = { name: col(COLS.name), site: col(COLS.site), user: col(COLS.user), pw: col(COLS.pw), note: col(COLS.note) };
  if (idx.pw < 0) return [];
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const host = (u: string) => u.replace(/^[a-z]+:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return rows
    .slice(1)
    .map((r) => {
      const site = host(get(r, idx.site));
      return { id: newId(), name: get(r, idx.name) || site || "Ohne Namen", site, user: get(r, idx.user), pw: get(r, idx.pw), note: get(r, idx.note) };
    })
    .filter((p) => p.pw !== "");
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toPasswordCsv(list: Pw[]): string {
  const rows = [["name", "url", "username", "password", "note"], ...list.map((p) => [p.name, p.site, p.user, p.pw, p.note])];
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// ---------- notes ----------

export function noteFromFile(fileName: string, text: string): Note {
  const title = fileName.replace(/\.(txt|md|markdown)$/i, "");
  return { id: newId(), title, text: text.replace(/\r\n?/g, "\n").trim(), pin: false, date: ymd(new Date()) };
}

export function notesToMarkdown(notes: Note[]): string {
  return notes.map((n) => `# ${n.title}\n\n${n.text}\n`).join("\n---\n\n");
}
