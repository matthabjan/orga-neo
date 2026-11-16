import { describe, expect, it } from "vitest";
import { parseCsv, parseIcs, parsePasswordCsv, parseVcf, toIcs, toPasswordCsv, toVcf } from "./io";
import { Contact, Ev, addDays, dueReminders, emptyOpen, occurrences, parseYmd, ymd } from "./model";

const ev = (o: Partial<Ev>): Ev => ({ id: "e", title: "T", date: "2026-11-17", time: "", place: "", note: "", rep: "", rem: -1, cat: "other", ...o });
const person = (o: Partial<Contact>): Contact => ({ id: "c", name: "Lukas Weber", rel: "", mobile: "", phone: "", street: "", city: "", mail: "", bday: "", note: "", ...o });

describe("iCalendar", () => {
  it("reads an Outlook-style file with folded lines, alarm and repeat", () => {
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Zahnarzt\\, Dr. Brandt", "DTSTART;TZID=Europe/Berlin:20261117T103000",
      "LOCATION:Praxis Linden", " straße 4", "RRULE:FREQ=YEARLY", "BEGIN:VALARM", "TRIGGER:-P1D", "END:VALARM", "END:VEVENT",
      "BEGIN:VEVENT", "SUMMARY:Gelber Sack", "DTSTART;VALUE=DATE:20261116", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const [a, b] = parseIcs(ics, "other");
    expect(a).toMatchObject({ title: "Zahnarzt, Dr. Brandt", date: "2026-11-17", time: "10:30", place: "Praxis Lindenstraße 4", rep: "yearly", rem: 1440, cat: "other" });
    expect(b).toMatchObject({ title: "Gelber Sack", date: "2026-11-16", time: "" });
  });

  it("survives a round trip", () => {
    const src = [ev({ title: "Kaffee; bei Sabine", time: "15:00", place: "Lindenweg 12", note: "Kuchen\nmitbringen", rep: "weekly", rem: 60 }), ev({ id: "x", title: "Ganztägig" })];
    const back = parseIcs(toIcs(src), "other");
    expect(back.map(({ id: _id, ...r }) => r)).toEqual(src.map(({ id: _id, ...r }) => r));
  });

  it("ignores repeats it cannot represent", () => {
    const ics = "BEGIN:VEVENT\nSUMMARY:x\nDTSTART:20260101T080000\nRRULE:FREQ=WEEKLY;INTERVAL=2\nEND:VEVENT";
    expect(parseIcs(ics, "o")[0].rep).toBe("");
  });
});

describe("vCard", () => {
  it("reads a phone export", () => {
    const vcf = "BEGIN:VCARD\nVERSION:3.0\nN:Weber;Sabine;;;\nFN:Sabine Weber\nTEL;TYPE=CELL:0171 2345678\nTEL;TYPE=HOME:0761 2233445\nADR;TYPE=HOME:;;Lindenweg 12;Freiburg;;79098;\nBDAY:19740312\nEMAIL:s@web.de\nEND:VCARD";
    expect(parseVcf(vcf)[0]).toMatchObject({ name: "Sabine Weber", mobile: "0171 2345678", phone: "0761 2233445", street: "Lindenweg 12", city: "79098 Freiburg", bday: "1974-03-12", mail: "s@web.de" });
  });

  it("falls back to N when FN is missing and survives a round trip", () => {
    expect(parseVcf("BEGIN:VCARD\nN:Kessler;Martin;;Dr.;\nEND:VCARD")[0].name).toBe("Dr. Martin Kessler");
    const src = [person({ mobile: "0157 1", street: "Am Bach 3", city: "79100 Freiburg", bday: "2012-11-21", rel: "Enkel", note: "Lego, Technic" })];
    const back = parseVcf(toVcf(src));
    expect(back.map(({ id: _id, ...r }) => r)).toEqual(src.map(({ id: _id, ...r }) => r));
  });
});

describe("password CSV", () => {
  it("parses quoted fields with commas, quotes and line breaks", () => {
    expect(parseCsv('a,"b,1","c ""x""","d\ne"\r\n1,2,3,4\n')).toEqual([["a", "b,1", 'c "x"', "d\ne"], ["1", "2", "3", "4"]]);
  });

  it("reads Edge/Chrome and Bitwarden exports", () => {
    const edge = "name,url,username,password,note\nSparkasse,https://www.sparkasse.de/login,weber,\"Tanne,47\",";
    expect(parsePasswordCsv(edge)[0]).toMatchObject({ name: "Sparkasse", site: "sparkasse.de", user: "weber", pw: "Tanne,47" });
    const bw = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,AOK,Hinweis,,0,https://aok.de,h@gmx.de,geheim,";
    expect(parsePasswordCsv(bw)[0]).toMatchObject({ name: "AOK", site: "aok.de", user: "h@gmx.de", pw: "geheim", note: "Hinweis" });
  });

  it("returns nothing for a file without a password column and round-trips its own export", () => {
    expect(parsePasswordCsv("a,b\n1,2")).toEqual([]);
    const src = [{ id: "1", name: 'WLAN "zu Hause"', site: "", user: "FRITZ!Box", pw: "a,b\"c", note: "Zeile 1\nZeile 2" }];
    expect(parsePasswordCsv(toPasswordCsv(src)).map(({ id: _id, ...r }) => r)).toEqual(src.map(({ id: _id, ...r }) => r));
  });
});

describe("appointments", () => {
  const range = (from: string, to: string, events: Ev[], contacts: Contact[] = []) =>
    occurrences(events, contacts, parseYmd(from), parseYmd(to)).map((o) => ymd(o.date));

  it("expands weekly, monthly and yearly repeats inside the range only", () => {
    expect(range("2026-11-16", "2026-11-30", [ev({ date: "2026-11-04", rep: "weekly" })])).toEqual(["2026-11-18", "2026-11-25"]);
    expect(range("2026-11-01", "2027-01-31", [ev({ date: "2026-11-05", rep: "monthly" })])).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    expect(range("2026-01-01", "2028-12-31", [ev({ date: "2027-03-01", rep: "yearly" })])).toEqual(["2027-03-01", "2028-03-01"]);
  });

  it("puts the 31st and 29 February on the last day of shorter months", () => {
    expect(range("2027-01-01", "2027-04-30", [ev({ date: "2027-01-31", rep: "monthly" })])).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(range("2027-01-01", "2028-12-31", [ev({ date: "2024-02-29", rep: "yearly" })])).toEqual(["2027-02-28", "2028-02-29"]);
  });

  it("adds birthdays from contacts and sorts by time within a day", () => {
    const list = occurrences([ev({ id: "late", time: "15:00" }), ev({ id: "early", time: "08:15" })], [person({ bday: "2012-11-17" })], parseYmd("2026-11-17"), parseYmd("2026-11-17"));
    expect(list.map((o) => o.ev.id)).toEqual(["b-c", "early", "late"]);
    expect(list[0].contact?.name).toBe("Lukas Weber");
  });

  it("shows a reminder from its lead time until it is confirmed", () => {
    const data = emptyOpen();
    data.events = [ev({ time: "10:30", rem: 1440 })];
    const at = (s: string) => new Date(s);
    expect(dueReminders(data, at("2026-11-16T10:00:00"))).toHaveLength(0);
    expect(dueReminders(data, at("2026-11-16T10:31:00"))).toHaveLength(1);
    data.done["e@2026-11-17"] = true;
    expect(dueReminders(data, at("2026-11-16T10:31:00"))).toHaveLength(0);
    expect(addDays(parseYmd("2026-12-31"), 1).getFullYear()).toBe(2027);
  });
});
