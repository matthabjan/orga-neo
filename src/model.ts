// Data types and pure helpers (dates, recurring appointments, defaults).

export type Repeat = "" | "weekly" | "monthly" | "yearly";
export type AreaId = "cal" | "addr" | "notes" | "docs" | "pw";
export type Scheme = "bunt" | "ruhig" | "kontrast";
export type TextSize = "m" | "l" | "xl";

export interface Category {
  id: string;
  name: string;
  /** Key into CAT_COLORS. */
  color: string;
}

export interface Ev {
  id: string;
  title: string;
  /** yyyy-mm-dd */
  date: string;
  /** hh:mm, empty for all-day */
  time: string;
  place: string;
  note: string;
  rep: Repeat;
  /** Minutes before the start to remind; -1 for no reminder. */
  rem: number;
  cat: string;
}

export interface Contact {
  id: string;
  name: string;
  rel: string;
  mobile: string;
  phone: string;
  street: string;
  city: string;
  mail: string;
  /** yyyy-mm-dd or empty */
  bday: string;
  note: string;
}

export interface Note {
  id: string;
  title: string;
  text: string;
  pin: boolean;
  /** yyyy-mm-dd of last change */
  date: string;
}

export interface Pw {
  id: string;
  name: string;
  site: string;
  user: string;
  pw: string;
  note: string;
}

export interface DocMeta {
  id: string;
  title: string;
  /** Id of the DocFolder it is filed in. */
  folder: string;
  /** Original file name, used for the type and for exporting. */
  file: string;
  size: number;
  date: string;
  /** yyyy-mm-dd when it was moved to the Papierkorb; absent while in use. */
  deleted?: string;
}

export interface Settings {
  appName: string;
  tagline: string;
  firstName: string;
  textSize: TextSize;
  scheme: Scheme;
  /** Areas shown as tiles on the start page, in order. */
  tiles: AreaId[];
  showNext: boolean;
  showBirthdays: boolean;
  showPinned: boolean;
  categories: Category[];
  /** Minutes without input after which passwords and documents lock. */
  autoLock: number;
  /** What happens to the original file after a document was stored encrypted. */
  originals: "ask" | "keep" | "trash";
  /** yyyy-mm-dd of the last backup made in the settings, "" for none. */
  lastBackup: string;
}

export interface OpenData {
  version: 1;
  settings: Settings;
  events: Ev[];
  contacts: Contact[];
  notes: Note[];
  /** Reminders already confirmed, keyed by `${eventId}@${date}`. */
  done: Record<string, true>;
}

/** A folder for documents. Only one level of subfolders is allowed. */
export interface DocFolder {
  id: string;
  name: string;
  /** Id of the parent folder, empty for a top-level folder. */
  parent: string;
}

export interface VaultData {
  passwords: Pw[];
  docs: DocMeta[];
  folders: DocFolder[];
}

/** Colours a category can have: [strong, tint, text on tint]. */
export const CAT_COLORS: Record<string, { name: string; c: string; t: string; ink: string }> = {
  plum: { name: "Beere", c: "#83346A", t: "#F4E6EF", ink: "#5E2049" },
  red: { name: "Rot", c: "#A63A2B", t: "#F8E5E1", ink: "#7A261B" },
  petrol: { name: "Petrol", c: "#22667D", t: "#E1EEF2", ink: "#17495A" },
  green: { name: "Grün", c: "#1D6A54", t: "#E3F0EB", ink: "#134A3A" },
  mustard: { name: "Senf", c: "#7A5C00", t: "#FAF0CC", ink: "#5A4400" },
  blue: { name: "Blau", c: "#22539C", t: "#E4ECF7", ink: "#183C72" },
  slate: { name: "Grau", c: "#3D4C57", t: "#E8EDEF", ink: "#2B3740" },
};

export const BDAY_CAT = "bday";

export const DEFAULT_FOLDERS = ["Ausweise", "Gesundheit", "Versicherungen", "Bank & Rente", "Haus & Wohnen", "Sonstiges"];

export const defaultFolders = (): DocFolder[] =>
  DEFAULT_FOLDERS.map((name, i) => ({ id: "f" + (i + 1), name, parent: "" }));

/** "Versicherungen › Kfz" */
export function folderPath(folders: DocFolder[], id: string): string[] {
  const f = folders.find((x) => x.id === id);
  if (!f) return [];
  const parent = f.parent ? folders.find((x) => x.id === f.parent) : undefined;
  return parent ? [parent.name, f.name] : [f.name];
}

/** Days a deleted document stays in the Papierkorb. */
export const TRASH_DAYS = 30;

/** Day on which a deleted document is removed for good. */
export const purgeDay = (d: DocMeta) => addDays(parseYmd(d.deleted!), TRASH_DAYS);

/** Documents in the Papierkorb whose time is up. */
export const expiredDocs = (docs: DocMeta[], now: Date) => docs.filter((d) => d.deleted && purgeDay(d) <= startOfDay(now));

/** Days since the last backup, or null when there was none. */
export const daysSinceBackup = (s: Settings, now: Date) =>
  s.lastBackup ? Math.round((startOfDay(now).getTime() - parseYmd(s.lastBackup).getTime()) / 864e5) : null;

export const ALL_AREAS: AreaId[] = ["cal", "addr", "notes", "docs", "pw"];

export function defaultSettings(): Settings {
  return {
    appName: "Orga-Neo",
    tagline: "Der Organizer von heute.",
    firstName: "",
    textSize: "m",
    scheme: "bunt",
    tiles: [...ALL_AREAS],
    showNext: true,
    showBirthdays: true,
    showPinned: true,
    categories: [
      { id: "health", name: "Arzt & Gesundheit", color: "red" },
      { id: "family", name: "Familie & Freunde", color: "plum" },
      { id: BDAY_CAT, name: "Geburtstage", color: "petrol" },
      { id: "home", name: "Haushalt", color: "mustard" },
      { id: "other", name: "Sonstiges", color: "slate" },
    ],
    autoLock: 10,
    originals: "ask",
    lastBackup: "",
  };
}

export function emptyOpen(): OpenData {
  return { version: 1, settings: defaultSettings(), events: [], contacts: [], notes: [], done: {} };
}

export function emptyVault(): VaultData {
  return { passwords: [], docs: [], folders: defaultFolders() };
}

/** Accept data written by older versions: fill in anything that is missing. */
export function normalizeOpen(raw: unknown): OpenData {
  const base = emptyOpen();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<OpenData>;
  const settings = { ...base.settings, ...(r.settings ?? {}) };
  if (!settings.categories?.length) settings.categories = base.settings.categories;
  if (!settings.categories.some((c) => c.id === BDAY_CAT))
    settings.categories.push({ id: BDAY_CAT, name: "Geburtstage", color: "petrol" });
  settings.tiles = (settings.tiles ?? []).filter((t) => ALL_AREAS.includes(t));
  const fallbackCat = settings.categories.find((c) => c.id !== BDAY_CAT)?.id ?? BDAY_CAT;
  return {
    version: 1,
    settings,
    events: (r.events ?? []).map((e) => ({
      ...{ time: "", place: "", note: "", rep: "" as Repeat, rem: -1, cat: fallbackCat },
      ...e,
    })),
    contacts: (r.contacts ?? []).map((c) => ({
      ...{ rel: "", mobile: "", phone: "", street: "", city: "", mail: "", bday: "", note: "" },
      ...c,
    })),
    notes: r.notes ?? [],
    done: r.done ?? {},
  };
}

export function normalizeVault(raw: unknown): VaultData {
  if (!raw || typeof raw !== "object") return emptyVault();
  const r = raw as Partial<VaultData>;
  const folders = r.folders?.length ? r.folders : defaultFolders();
  const docs = (r.docs ?? []).map((d) => (folders.some((f) => f.id === d.folder) ? d : { ...d, folder: folders[0].id }));
  return { passwords: (r.passwords ?? []).map((p) => ({ ...{ site: "", user: "", note: "" }, ...p })), docs, folders };
}

// ---------- dates ----------

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-DE", o).format(d);

/** "Heute", "Morgen", "in 3 Tagen" … or "" when further away or in the past. */
export function relDay(d: Date, now: Date): string {
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 864e5);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Morgen";
  if (diff === 2) return "Übermorgen";
  if (diff > 2 && diff < 7) return `in ${diff} Tagen`;
  return "";
}

// ---------- appointments ----------

export interface Occurrence {
  ev: Ev;
  date: Date;
  /** Set when this is a birthday taken from the address book. */
  contact?: Contact;
}

/** A day-of-month that does not exist (31st in April, 29 Feb) falls on the month's last day. */
function clampDay(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

export function birthdayEvent(c: Contact): Ev {
  return {
    id: "b-" + c.id,
    title: "Geburtstag " + c.name,
    date: c.bday,
    time: "",
    place: "",
    note: "",
    rep: "yearly",
    rem: 0,
    cat: BDAY_CAT,
  };
}

/** All appointments and birthdays between two days (inclusive), in order. */
export function occurrences(events: Ev[], contacts: Contact[], from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];
  from = startOfDay(from);
  to = startOfDay(to);
  const all: { ev: Ev; contact?: Contact }[] = [
    ...events.map((ev) => ({ ev })),
    ...contacts.filter((c) => c.bday).map((c) => ({ ev: birthdayEvent(c), contact: c })),
  ];
  for (const { ev, contact } of all) {
    const start = parseYmd(ev.date);
    if (isNaN(start.getTime())) continue;
    const push = (d: Date) => {
      if (d >= from && d <= to && d >= start) out.push({ ev, date: d, contact });
    };
    if (!ev.rep) {
      push(start);
    } else if (ev.rep === "weekly") {
      let d = new Date(start);
      if (d < from) {
        const weeks = Math.floor((from.getTime() - d.getTime()) / (7 * 864e5));
        d = addDays(d, weeks * 7);
        if (d < from) d = addDays(d, 7);
      }
      for (let guard = 0; d <= to && guard < 600; guard++, d = addDays(d, 7)) push(d);
    } else if (ev.rep === "monthly") {
      let y = Math.max(start.getFullYear(), from.getFullYear());
      let m = y === from.getFullYear() ? from.getMonth() : 0;
      if (y === start.getFullYear()) m = Math.max(m, start.getMonth());
      for (let guard = 0; guard < 600; guard++) {
        const d = clampDay(y, m, start.getDate());
        if (d > to) break;
        push(d);
        if (++m > 11) {
          m = 0;
          y++;
        }
      }
    } else {
      for (let y = Math.max(start.getFullYear(), from.getFullYear()); y <= to.getFullYear(); y++)
        push(clampDay(y, start.getMonth(), start.getDate()));
    }
  }
  return out.sort(
    (a, b) => a.date.getTime() - b.date.getTime() || (a.ev.time || "00:00").localeCompare(b.ev.time || "00:00"),
  );
}

/** Age the person reaches on `on`. */
export const ageOn = (c: Contact, on: Date) => on.getFullYear() - parseYmd(c.bday).getFullYear();

/** When an occurrence starts; all-day entries count from 9:00. */
export function startTime(o: Occurrence): Date {
  const [h, m] = (o.ev.time || "09:00").split(":").map(Number);
  const d = new Date(o.date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

export const occKey = (o: Occurrence) => `${o.ev.id}@${ymd(o.date)}`;

/** Reminders that should be on screen right now. */
export function dueReminders(data: OpenData, now: Date): Occurrence[] {
  return occurrences(data.events, data.contacts, addDays(now, -1), addDays(now, 8)).filter((o) => {
    if (o.ev.rem < 0 || data.done[occKey(o)]) return false;
    const start = startTime(o);
    const due = new Date(start.getTime() - o.ev.rem * 60_000);
    const expires = new Date(start.getTime() + 12 * 3_600_000);
    return now >= due && now <= expires;
  });
}

/** relDay for the middle of a sentence: "heute", "morgen", "in 3 Tagen". */
export const relLower = (d: Date, now: Date) => relDay(d, now).replace(/^[HMÜ]/, (c) => c.toLowerCase());

export const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

export function initials(name: string): string {
  return name
    .replace(/^(Dr\.|Prof\.)\s*/g, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Sort key: "Nachname Vorname" for people, the name itself for anything else. */
export function sortName(c: Contact): string {
  const n = c.name.replace(/^(Dr\.|Prof\.)\s*/g, "").trim();
  const parts = n.split(" ");
  return parts.length === 2 ? parts[1] + " " + parts[0] : n;
}

const WORDS = [
  "Tanne", "Kompass", "Regen", "Leuchtturm", "Wiese", "Mosel", "Kerze", "Fahrrad", "Zimt", "Anker", "Holunder",
  "Blitz", "Tafel", "Garten", "Mond", "Kiesel", "Eiche", "Brunnen", "Feder", "Sommer", "Kastanie", "Pfad", "Apfel",
  "Birke", "Wolke", "Hafen", "Linde", "Nebel", "Quelle", "Segel", "Stern", "Tulpe", "Ufer", "Welle", "Ziegel",
  "Ahorn", "Bach", "Dach", "Falke", "Giebel", "Hagel", "Insel", "Kranich", "Laterne", "Muschel", "Orgel", "Pinsel",
];

/** A password that is easy to read and type, e.g. `Tanne-Kompass-Regen-47`. */
export function passphrase(): string {
  const r = crypto.getRandomValues(new Uint32Array(4));
  const pick = (i: number) => WORDS[r[i] % WORDS.length];
  return `${pick(0)}-${pick(1)}-${pick(2)}-${10 + (r[3] % 90)}`;
}
