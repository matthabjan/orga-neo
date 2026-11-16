// First start: name, master password, recovery sheet.

import { ic } from "../icons";
import { addSampleOpen, addSampleVault } from "../sample";
import { S, act, appName, applySettings, errorText, esc, form, go, render, saveOpen, saveVault } from "../state";
import { codesHtml, rememberCodes } from "./settings";
import { loadVault } from "./vault";

export function vSetup(): string {
  const st = S.setup;
  const steps = ["Ihr Name", "Master-Passwort", "Notfallblatt"];
  const progress = `<ol class="steps">${steps.map((s, i) => `<li ${i + 1 === st.step ? 'aria-current="step"' : ""} class="${i + 1 < st.step ? "done" : ""}"><span>${i + 1 < st.step ? ic("check") : i + 1}</span>${s}</li>`).join("")}</ol>`;
  let body = "";
  if (st.step === 1)
    body = `<form data-form="setup-name" novalidate><h1>Willkommen bei ${esc(appName())}</h1>
      <p class="lead">Termine, Kontakte, Notizen, Dokumente und Passwörter an einem Ort. Die Einrichtung dauert zwei Minuten.</p>
      <div class="field"><label for="su-name">Wie ist Ihr Vorname?</label><input class="inp big" id="su-name" name="firstName" value="${esc(st.firstName)}" autocomplete="off" autofocus><div class="hint">Damit begrüßt Sie das Programm auf der Startseite.</div></div>
      <label class="check"><input type="checkbox" name="sample" ${st.sample ? "checked" : ""}><span>Mit Beispieldaten starten, um alles auszuprobieren</span></label>
      <p class="err" id="form-err" role="alert"></p>
      <button class="btn pri big" style="--accent:var(--ink)">Weiter</button></form>`;
  else if (st.step === 2)
    body = `<form data-form="setup-master" novalidate><h1>Ihr Master-Passwort</h1>
      <p class="lead">Es schützt Ihre Passwörter und Dokumente. Es ist das einzige Passwort, das Sie sich künftig merken müssen. Gut geeignet sind drei oder vier Wörter hintereinander, zum Beispiel „Garten-Mond-Kiesel-71“.</p>
      <div class="field"><label for="su-a">Master-Passwort</label><div class="pw-wrap"><input class="inp big" id="su-a" name="a" type="password" autocomplete="new-password" autofocus><button class="btn ghost" type="button" data-act="toggle-secret" data-for="su-a su-b">${ic("eye")}<span>Zeigen</span></button></div><div class="hint">Mindestens 10 Zeichen</div></div>
      <div class="field"><label for="su-b">Noch einmal eingeben</label><input class="inp big" id="su-b" name="b" type="password" autocomplete="new-password"></div>
      <p class="err" id="form-err" role="alert"></p>
      <div class="btnrow"><button type="button" class="btn ghost big" data-act="setup-back">Zurück</button><button class="btn pri big" style="--accent:var(--ink)">Weiter</button></div></form>`;
  else
    body = `<form data-form="setup-done" novalidate><h1>Ihr Notfallblatt</h1>
      <p class="lead">Falls Sie das Master-Passwort einmal vergessen, öffnen diese Codes Ihre Passwörter und Dokumente. Ohne Passwort und ohne Code gibt es keinen Zugang mehr, auch nicht durch einen Fachmann.</p>
      ${st.codes ? codesHtml(st.codes) : ""}
      <p>Drucken Sie zwei Blätter: eines für Ihre Unterlagen zu Hause, eines im verschlossenen Umschlag für eine Person Ihres Vertrauens.</p>
      <div class="btnrow"><button type="button" class="btn sec big" data-act="print-codes">${ic("print")}Beide Blätter drucken</button></div>
      <label class="check"><input type="checkbox" name="ok"><span>Ich habe die Blätter gedruckt oder die Codes abgeschrieben</span></label>
      <p class="err" id="form-err" role="alert"></p>
      <button class="btn pri big" style="--accent:var(--ink)">Fertig, ${esc(appName())} öffnen</button></form>`;
  return `<div class="setup"><div class="setup-top"><div class="brand"><span class="rings" aria-hidden="true"><i></i><i></i><i></i></span>${esc(appName())}</div>${progress}</div><div class="setup-card">${body}</div></div>`;
}

act("setup-back", () => {
  S.setup.step = 1;
  render();
});

form("setup-name", (v) => {
  S.setup.firstName = v.firstName.trim();
  S.setup.sample = v.sample === "on";
  S.setup.step = 2;
  render();
});

form("setup-master", async (v, f) => {
  const err = document.getElementById("form-err")!;
  if (v.a.length < 10) return void (err.textContent = "Das Passwort braucht mindestens 10 Zeichen.");
  if (v.a !== v.b) return void (err.textContent = "Die beiden Eingaben sind verschieden. Bitte tippen Sie beide noch einmal.");
  const btn = f.querySelector("button.pri") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const codes = await S.backend.vaultCreate(v.a);
    S.setup.codes = codes;
    rememberCodes(codes);
    await loadVault();
    S.data.settings.firstName = S.setup.firstName;
    if (S.setup.sample) {
      addSampleOpen(S.data);
      addSampleVault(S.vault!);
      await saveVault();
    }
    saveOpen();
    applySettings();
    S.setup.step = 3;
    render();
  } catch (e) {
    btn.disabled = false;
    err.textContent = errorText(e);
  }
});

form("setup-done", (v) => {
  if (v.ok !== "on") return void (document.getElementById("form-err")!.textContent = "Bitte bestätigen Sie, dass Sie die Codes gesichert haben.");
  S.setup.codes = null;
  go("home");
});
