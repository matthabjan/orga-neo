// @vitest-environment happy-dom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { csvSheet, formatNumber, isDateFormat, readXlsx } from "./office";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function xlsx(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return zip.generateAsync({ type: "uint8array" });
}

const book = (sheets: string, extra = "") => `<?xml version="1.0"?><workbook ${NS}>${extra}<sheets>${sheets}</sheets></workbook>`;
const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`;
const sheet = (rows: string) => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;

describe("Excel preview", () => {
  it("reads shared and inline text, numbers, dates and booleans", async () => {
    const bytes = await xlsx({
      "xl/workbook.xml": book('<sheet name="Haushalt" sheetId="1" r:id="rId1"/>'),
      "xl/_rels/workbook.xml.rels": rels,
      "xl/sharedStrings.xml": `<sst ${NS}><si><t>Miete</t></si><si><r><t>Strom </t></r><r><t>&amp; Gas</t></r><rPh><t>x</t></rPh></si></sst>`,
      "xl/styles.xml": `<styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>
        <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="9"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": sheet(`
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" s="2"><v>1234.5</v></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>46343</v></c><c r="C2" s="3"><v>0.25</v></c></row>
        <row r="4"><c r="A4" t="inlineStr"><is><t>Notiz</t></is></c><c r="B4" t="b"><v>1</v></c><c r="C4" t="str"><v>Summe</v></c></row>
        <row r="5"><c r="A5"/></row>`),
    });
    const [s] = await readXlsx(bytes);
    expect(s.name).toBe("Haushalt");
    expect(s.cut).toBe(false);
    expect(s.rows).toEqual([
      ["Miete", "", "1.234,50 €"],
      ["Strom & Gas", "17.11.2026", "25 %"],
      [],
      ["Notiz", "WAHR", "Summe"],
    ]);
  });

  it("skips hidden sheets and follows absolute targets", async () => {
    const bytes = await xlsx({
      "xl/workbook.xml": book('<sheet name="Versteckt" sheetId="1" state="hidden" r:id="rId1"/><sheet name="Zwei" sheetId="2" r:id="rId2"/>'),
      "xl/_rels/workbook.xml.rels": rels,
      "xl/worksheets/sheet1.xml": sheet('<row r="1"><c r="A1"><v>1</v></c></row>'),
      "xl/worksheets/sheet2.xml": sheet('<row><c><v>7</v></c><c><v>8</v></c></row>'),
    });
    const sheets = await readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(["Zwei"]);
    expect(sheets[0].rows).toEqual([["7", "8"]]);
  });

  it("stops at 500 rows and says so", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    const bytes = await xlsx({ "xl/workbook.xml": book('<sheet name="A" sheetId="1" r:id="rId1"/>'), "xl/_rels/workbook.xml.rels": rels, "xl/worksheets/sheet1.xml": sheet(rows) });
    const [s] = await readXlsx(bytes);
    expect(s.rows.length).toBe(500);
    expect(s.cut).toBe(true);
  });

  it("rejects files that are not spreadsheets", async () => {
    await expect(readXlsx(await xlsx({ "word/document.xml": "<x/>" }))).rejects.toBe("unreadable");
  });

  it("formats numbers in German notation", () => {
    expect(formatNumber(0.1 + 0.2, "General")).toBe("0,3");
    expect(formatNumber(1234567, "#,##0")).toBe("1.234.567");
    expect(formatNumber(45000.75, "dd.mm.yyyy hh:mm")).toBe("15.03.2023 18:00");
    expect(formatNumber(0, "dd/mm/yyyy", true)).toBe("01.01.1904");
    expect(isDateFormat('"Tag" 0')).toBe(false);
    expect(isDateFormat("[Red]0.00")).toBe(false);
  });
});

describe("CSV preview", () => {
  it("detects semicolons", () => {
    expect(csvSheet("Name;Betrag\nMiete;800,00\n").rows).toEqual([["Name", "Betrag"], ["Miete", "800,00"]]);
    expect(csvSheet('a,"b,c"\n').rows).toEqual([["a", "b,c"]]);
  });
});
