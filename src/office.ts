// Previews of office files inside the app. Loaded on demand (dynamic import),
// so the libraries are not part of the app's start.
//
// Word (.docx) goes through docx-preview. Spreadsheets (.xlsx) are read here
// directly from the zip: only the cell values, shown as a plain table. Both
// work on the decrypted bytes in memory; nothing is written to disk.

import JSZip from "jszip";
import { parseCsv } from "./io";

export interface Sheet {
  name: string;
  rows: string[][];
  /** More rows or columns exist than `rows` holds. */
  cut: boolean;
}

const MAX_ROWS = 500;
const MAX_COLS = 50;

// ---------- spreadsheets ----------

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
/** Child elements by local name, ignoring namespace prefixes. */
const kids = (el: Element | Document, name: string) => Array.from(el.getElementsByTagName("*")).filter((x) => x.localName === name);
const attr = (el: Element, name: string) => el.getAttribute(name) ?? "";

async function part(zip: JSZip, path: string): Promise<Document | null> {
  const f = zip.file(path);
  return f ? xml(await f.async("string")) : null;
}

/** "B12" → 1 (zero-based column). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Number formats Excel has built in, by id. Only what matters for display. */
const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%",
  14: "dd.mm.yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
  20: "hh:mm", 21: "hh:mm:ss", 22: "dd.mm.yyyy hh:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0",
};

/** The format code without quoted text, escapes and [colour] parts, first section only. */
const bareFormat = (code: string) => code.split(";")[0].replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");

export const isDateFormat = (code: string) => /[dmyhs]/i.test(bareFormat(code)) && !/^general$/i.test(code.trim());

/** Show a cell value the way the format roughly says, in German notation. */
export function formatNumber(value: number, code: string, date1904 = false): string {
  if (!isFinite(value)) return String(value);
  const bare = bareFormat(code);
  if (isDateFormat(code)) {
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.round(value * 864e5));
    const p = (n: number) => String(n).padStart(2, "0");
    const hasDate = /[dy]/i.test(bare) || /m{3,}/i.test(bare) || (value >= 1 && !/[hs]/i.test(bare));
    const hasTime = /[hs]/i.test(bare);
    const date = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${/s/i.test(bare) ? ":" + p(d.getUTCSeconds()) : ""}`;
    return [hasDate ? date : "", hasTime ? time : ""].filter(Boolean).join(" ");
  }
  const decimals = (bare.match(/\.(0+)/)?.[1].length ?? 0);
  const general = !/[0#]/.test(bare);
  const percent = bare.includes("%");
  const n = percent ? value * 100 : value;
  const text = general
    ? n.toLocaleString("de-DE", { maximumFractionDigits: 10, useGrouping: false })
    : n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: bare.includes(",") });
  const currency = code.includes("€") ? " €" : code.includes("$") ? " $" : "";
  return text + (percent ? " %" : "") + currency;
}

/** Read the visible sheets of an .xlsx file as rows of display text. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(bytes);
  const book = await part(zip, "xl/workbook.xml");
  if (!book) throw "unreadable";
  const date1904 = kids(book, "workbookPr").some((el) => ["1", "true"].includes(attr(el, "date1904")));

  const rels = await part(zip, "xl/_rels/workbook.xml.rels");
  const target = new Map<string, string>();
  for (const r of rels ? kids(rels, "Relationship") : []) {
    const t = attr(r, "Target");
    target.set(attr(r, "Id"), t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
  }

  const sst = await part(zip, "xl/sharedStrings.xml");
  // Text runs, but not the phonetic hints (<rPh>) that some files carry.
  const runText = (si: Element) => kids(si, "t").filter((t) => t.parentElement?.localName !== "rPh").map((t) => t.textContent ?? "").join("");
  const shared = sst ? kids(sst, "si").map(runText) : [];

  const styles = await part(zip, "xl/styles.xml");
  const custom = new Map<number, string>();
  for (const f of styles ? kids(styles, "numFmt") : []) custom.set(Number(attr(f, "numFmtId")), attr(f, "formatCode"));
  const cellXfs = styles ? kids(styles, "cellXfs")[0] : undefined;
  const xfFormat = cellXfs
    ? kids(cellXfs, "xf").map((xf) => {
        const id = Number(attr(xf, "numFmtId"));
        return custom.get(id) ?? BUILTIN_FORMATS[id] ?? "General";
      })
    : [];

  const sheets: Sheet[] = [];
  for (const s of kids(book, "sheet")) {
    if (attr(s, "state") && attr(s, "state") !== "visible") continue;
    const relId = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || attr(s, "r:id");
    const doc = await part(zip, target.get(relId) ?? "");
    if (!doc) continue;
    const rows: string[][] = [];
    let cut = false;
    let next = 0;
    for (const row of kids(doc, "row")) {
      const r = attr(row, "r") ? Number(attr(row, "r")) - 1 : next;
      next = r + 1;
      if (r >= MAX_ROWS) {
        cut = true;
        break;
      }
      const cells: string[] = [];
      let col = 0;
      for (const c of kids(row, "c")) {
        col = attr(c, "r") ? colIndex(attr(c, "r")) : col;
        if (col >= MAX_COLS) {
          cut = true;
          break;
        }
        const v = kids(c, "v")[0]?.textContent ?? "";
        const type = attr(c, "t");
        let text = v;
        if (type === "s") text = shared[Number(v)] ?? "";
        else if (type === "inlineStr") text = kids(c, "is").map(runText).join("");
        else if (type === "b") text = v === "1" ? "WAHR" : "FALSCH";
        else if (type !== "str" && type !== "e" && v !== "") text = formatNumber(Number(v), xfFormat[Number(attr(c, "s") || 0)] ?? "General", date1904);
        cells[col] = text;
        col++;
      }
      rows[r] = Array.from(cells, (x) => x ?? "");
    }
    const filled = Array.from(rows, (x) => x ?? []);
    while (filled.length && !filled[filled.length - 1].some(Boolean)) filled.pop();
    sheets.push({ name: attr(s, "name"), rows: filled, cut });
  }
  return sheets;
}

/** Rows of a CSV file as one sheet (comma or semicolon separated). */
export function csvSheet(text: string): Sheet {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const all = parseCsv(text, sep);
  const cut = all.length > MAX_ROWS || all.some((r) => r.length > MAX_COLS);
  return { name: "Tabelle", rows: all.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), cut };
}

// ---------- Word ----------

/** Render a .docx into `into`. Links are made inert: a click must not leave the app. */
export async function renderDocx(bytes: Uint8Array, into: HTMLElement): Promise<void> {
  const { renderAsync } = await import("docx-preview");
  await renderAsync(new Blob([bytes as BlobPart]), into, undefined, {
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    // Pictures as data: URLs, which the CSP allows.
    useBase64URL: true,
    // Embedded HTML ("altChunk") would need an iframe; comments and tracked changes would confuse.
    renderAltChunks: false,
    renderComments: false,
    renderChanges: false,
  });
  for (const a of Array.from(into.querySelectorAll("a[href]"))) a.removeAttribute("href");
  for (const el of Array.from(into.querySelectorAll("iframe, script, object, embed"))) el.remove();
}
