// Made-up entries for trying the app out. Dates are relative to today.

import { Contact, Ev, Note, OpenData, Pw, VaultData, addDays, newId, ymd } from "./model";

export function addSampleOpen(d: OpenData) {
  const t = new Date();
  const day = (n: number) => ymd(addDays(t, n));
  const bday = (year: number, inDays: number) => {
    const x = addDays(t, inDays);
    return `${year}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  const ev = (o: Partial<Ev>): Ev => ({ id: newId(), title: "", date: day(0), time: "", place: "", note: "", rep: "", rem: -1, cat: "other", ...o });
  d.events.push(
    ev({ title: "Gelber Sack rausstellen", cat: "home" }),
    ev({ title: "Zahnarzt Dr. Brandt", date: day(1), time: "10:30", place: "Praxis Lindenstraße 4", rem: 1440, cat: "health" }),
    ev({ title: "Physiotherapie", date: day(-12), time: "14:00", place: "Physio am Park", rep: "weekly", cat: "health" }),
    ev({ title: "Kaffee bei Sabine", date: day(3), time: "15:00", cat: "family" }),
    ev({ title: "Blutabnahme Hausarzt", date: day(7), time: "08:15", place: "Dr. Kessler, Marktplatz 2", note: "Nüchtern kommen.", rem: 1440, cat: "health" }),
    ev({ title: "Seniorentreff", date: day(-11), time: "14:30", place: "Gemeindehaus", rep: "monthly", cat: "family" }),
    ev({ title: "Hörgeräte-Akustiker", date: day(17), time: "11:00", cat: "health" }),
  );
  const c = (o: Partial<Contact>): Contact => ({ id: newId(), name: "", rel: "", mobile: "", phone: "", street: "", city: "", mail: "", bday: "", note: "", ...o });
  d.contacts.push(
    c({ name: "Sabine Weber", rel: "Tochter", mobile: "0171 2345678", phone: "0761 2233445", street: "Lindenweg 12", city: "79098 Freiburg", mail: "sabine.weber@example.de", bday: bday(1974, 120) }),
    c({ name: "Lukas Weber", rel: "Enkel", mobile: "0157 88812345", street: "Lindenweg 12", city: "79098 Freiburg", bday: bday(t.getFullYear() - 14, 5), note: "Wünscht sich Lego Technic." }),
    c({ name: "Klaus Weber", rel: "Bruder", phone: "0711 6655443", street: "Rosenstraße 8", city: "70173 Stuttgart", bday: bday(1949, 13) }),
    c({ name: "Gerhard Maier", rel: "Nachbar", mobile: "0160 4433221", street: "Am Bach 3", city: "79100 Freiburg", bday: bday(1944, 16), note: "Hat einen Ersatzschlüssel." }),
    c({ name: "Dr. Martin Kessler", rel: "Hausarzt", phone: "0761 445566", street: "Marktplatz 2", city: "79098 Freiburg", note: "Sprechstunde Mo–Fr 8–12 Uhr." }),
    c({ name: "Dr. Anna Brandt", rel: "Zahnärztin", phone: "0761 778899", street: "Lindenstraße 4", city: "79098 Freiburg" }),
    c({ name: "Taxi-Zentrale", phone: "0761 55555" }),
  );
  const n = (o: Partial<Note>): Note => ({ id: newId(), title: "", text: "", pin: false, date: day(0), ...o });
  d.notes.push(
    n({ title: "Fragen an Dr. Kessler", pin: true, date: day(-2), text: "Für die Blutabnahme:\n\n- Soll ich die Blutdrucktablette morgens trotzdem nehmen?\n- Neues Rezept\n- Knie rechts seit drei Wochen schlechter" }),
    n({ title: "Einkaufsliste", pin: true, date: day(-1), text: "Milch\nVollkornbrot\nÄpfel\nBatterien für Hörgerät, Größe 312" }),
    n({ title: "Zählerstände", date: day(-40), text: "Strom: 48.211 kWh\nWasser: 1.032 m³" }),
  );
}

export function addSampleVault(v: VaultData) {
  const p = (name: string, site: string, user: string, pw: string, note = ""): Pw => ({ id: newId(), name, site, user, pw, note });
  v.passwords.push(
    p("Sparkasse Online-Banking", "sparkasse.de", "beispiel.nutzer", "Tanne-Kompass-Regen-47", "Nur ein Beispiel."),
    p("E-Mail", "gmx.de", "beispiel@example.de", "Holunder-Blitz-Tafel-29"),
    p("WLAN zu Hause", "", "FRITZ!Box", "Sommer-Kastanie-Pfad-90", "Für Besuch gibt es das Gäste-WLAN."),
  );
}
