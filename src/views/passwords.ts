// Passwörter (inside the vault).

import { ic } from "../icons";
import { Pw, newId, passphrase } from "../model";
import { S, act, closeDialog, confirmDialog, esc, form, go, openDialog, render, saveVault, toast } from "../state";

const row = (p: Pw) =>
  `<li><button class="row" data-act="open-pw" data-id="${p.id}"><span class="av">${esc((p.name[0] ?? "?").toUpperCase())}</span><span><span class="t">${esc(p.name)}</span><br><span class="m">${esc(p.user) || "&nbsp;"}</span></span><span class="end">${esc(p.site)}</span></button></li>`;

export function vPasswords(): string {
  const all = S.vault!.passwords;
  const q = S.search.trim().toLowerCase();
  const list = all.filter((p) => !q || (p.name + p.site + p.user).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, "de"));
  let html = "";
  let last = "";
  for (const p of list) {
    const letter = (p.name[0] ?? "#").toUpperCase();
    if (letter !== last) {
      html += `<li class="letter" aria-hidden="true">${esc(letter)}</li>`;
      last = letter;
    }
    html += row(p);
  }
  const body = all.length
    ? `<div class="toolbar"><label class="search"><span class="sr">Passwörter durchsuchen</span>${ic("search")}<input id="q" type="search" placeholder="Name oder Webseite suchen" value="${esc(S.search)}"></label></div>
       <ul class="rows">${html || `<li><p class="empty" style="padding:1rem .8rem">Kein Eintrag passt zu „${esc(S.search)}“.</p></li>`}</ul>`
    : `<div class="blank">${ic("key")}<h2>Noch keine Passwörter</h2><p>Speichern Sie hier Ihre Zugangsdaten. Sie müssen sich dann nur noch das Master-Passwort merken.</p><button class="btn pri big" data-act="new-pw">${ic("plus")}Erstes Passwort hinzufügen</button></div>`;
  return `<header class="ph"><div><h1>Passwörter</h1><p>Klicken Sie auf einen Eintrag, um das Passwort zu sehen oder zu kopieren.</p></div>
  <button class="btn pri big" data-act="new-pw">${ic("plus")}Passwort hinzufügen</button></header>${body}`;
}

function showPw(p: Pw) {
  const val = (label: string, value: string, extra = "") =>
    value ? `<div class="field"><span class="lb">${label}</span><div class="val"><span class="v">${esc(value)}</span>${extra}<button class="btn sec" data-act="copy" data-text="${esc(value)}">${ic("copy")}Kopieren</button></div></div>` : "";
  openDialog(`<div class="dh"><span class="av">${esc((p.name[0] ?? "?").toUpperCase())}</span><div><h2 id="dlg-title">${esc(p.name)}</h2>${p.site ? `<div class="m">${esc(p.site)}</div>` : ""}</div>
    <button class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
  <div class="db">
    ${val("Benutzername", p.user)}
    <div class="field"><span class="lb">Passwort</span><div class="val"><span class="v secret" id="pwv" data-pw="${esc(p.pw)}">••••••••••••</span>
      <button class="btn ghost" data-act="reveal-pw">${ic("eye")}<span>Zeigen</span></button><button class="btn pri" autofocus style="--accent:var(--green)" data-act="copy" data-text="${esc(p.pw)}" data-secret="1">${ic("copy")}Kopieren</button></div></div>
    ${val("Webseite", p.site)}
    ${p.note ? `<div class="field"><span class="lb">Notiz</span><div class="note">${esc(p.note)}</div></div>` : ""}
  </div>
  <div class="df"><button class="btn danger left" data-act="delete-pw" data-id="${p.id}">Löschen</button><button class="btn sec" data-act="edit-pw" data-id="${p.id}">Bearbeiten</button><button class="btn pri" style="--accent:var(--green)" data-act="close">Fertig</button></div>`);
}

function editPw(p: Pw, isNew: boolean) {
  openDialog(`<form data-form="pw" novalidate>
  <div class="dh"><h2 id="dlg-title">${isNew ? "Passwort hinzufügen" : "Eintrag ändern"}</h2><button type="button" class="iconbtn x" data-act="close" aria-label="Schließen">${ic("x")}</button></div>
  <div class="db">
    <input type="hidden" name="id" value="${isNew ? "" : p.id}">
    <div class="field"><label for="p-name">Wofür?</label><input class="inp" id="p-name" name="name" value="${esc(p.name)}" placeholder="z. B. Sparkasse Online-Banking" required autofocus></div>
    <div class="two"><div class="field"><label for="p-user">Benutzername</label><input class="inp" id="p-user" name="user" value="${esc(p.user)}" autocomplete="off"></div>
    <div class="field"><label for="p-site">Webseite <span class="opt">(freiwillig)</span></label><input class="inp" id="p-site" name="site" value="${esc(p.site)}" placeholder="sparkasse.de"></div></div>
    <div class="field"><label for="p-pw">Passwort</label><div class="val" style="padding-left:.4rem"><input class="inp" id="p-pw" name="pw" value="${esc(p.pw)}" autocomplete="off" style="border:0;background:transparent;box-shadow:none;flex:1">
      <button type="button" class="btn sec" data-act="gen-pw">${ic("dice")}Vorschlag</button></div><div class="hint">„Vorschlag“ erzeugt ein sicheres, gut lesbares Passwort.</div></div>
    <div class="field"><label for="p-note">Notiz <span class="opt">(freiwillig)</span></label><input class="inp" id="p-note" name="note" value="${esc(p.note)}"></div>
    <p class="err" id="form-err" role="alert"></p>
  </div>
  <div class="df"><button type="button" class="btn ghost" data-act="close">Abbrechen</button><button class="btn pri" style="--accent:var(--green)">Speichern</button></div></form>`);
}

let clipTimer: number | undefined;

act("open-pw", (el) => {
  const p = S.vault?.passwords.find((x) => x.id === el.dataset.id);
  if (!p) return;
  if (S.view !== "pw") go("pw");
  showPw(p);
});
act("new-pw", () => editPw({ id: "", name: "", site: "", user: "", pw: "", note: "" }, true));
act("edit-pw", (el) => {
  const p = S.vault?.passwords.find((x) => x.id === el.dataset.id);
  if (p) editPw(p, false);
});
act("gen-pw", () => {
  (document.getElementById("p-pw") as HTMLInputElement).value = passphrase();
});
act("reveal-pw", (el) => {
  const v = document.getElementById("pwv")!;
  const hidden = v.textContent!.startsWith("•");
  v.textContent = hidden ? v.dataset.pw! : "••••••••••••";
  v.classList.toggle("secret", !hidden);
  el.querySelector("span")!.textContent = hidden ? "Verbergen" : "Zeigen";
});
act("copy", async (el) => {
  const text = el.dataset.text ?? "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return toast("Kopieren hat nicht geklappt. Bitte markieren und Strg+C drücken.");
  }
  if (el.dataset.secret) {
    // do not leave a password in the clipboard for long
    clearTimeout(clipTimer);
    clipTimer = window.setTimeout(() => void navigator.clipboard.writeText("").catch(() => {}), 60_000);
    toast("Kopiert. Mit Strg+V einfügen. Nach 1 Minute wird es wieder gelöscht.");
  } else toast("Kopiert. Mit Strg+V einfügen.");
});
act("delete-pw", async (el) => {
  const p = S.vault?.passwords.find((x) => x.id === el.dataset.id);
  if (!p || !(await confirmDialog(`„${p.name}“ löschen?`, "Der Eintrag und das Passwort werden endgültig gelöscht."))) return;
  S.vault!.passwords = S.vault!.passwords.filter((x) => x.id !== p.id);
  await saveVault();
  closeDialog();
  render();
  toast("Eintrag gelöscht.");
});

form("pw", async (v) => {
  const err = document.getElementById("form-err")!;
  if (!v.name.trim()) return void (err.textContent = "Bitte tragen Sie ein, wofür das Passwort ist.");
  if (!v.pw) return void (err.textContent = "Bitte tragen Sie das Passwort ein oder klicken Sie auf „Vorschlag“.");
  const p: Pw = { id: v.id || newId(), name: v.name.trim(), site: v.site.trim().replace(/^https?:\/\//, ""), user: v.user.trim(), pw: v.pw, note: v.note.trim() };
  const list = S.vault!.passwords;
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  await saveVault();
  closeDialog();
  render();
  toast("Passwort gespeichert.");
});
