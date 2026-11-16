// The "Tresor": passwords and documents sit behind the master password.

import { ic } from "../icons";
import { AreaId, normalizeVault } from "../model";
import { AREAS, S, act, closeDialog, errorText, form, render, toast } from "../state";

let useCode = false;

/** Shown instead of Dokumente / Passwörter while the vault is closed. */
export function vGate(area: AreaId): string {
  const a = AREAS[area];
  return `<div class="gate"><form data-form="unlock" novalidate>
    <span class="gate-ic" style="background:${a.t};color:${a.c}">${ic("lock")}</span>
    <h1>${a.label} öffnen</h1>
    <p>${a.label} sind verschlüsselt. ${useCode ? "Geben Sie den Code von Ihrem Notfallblatt ein." : "Geben Sie Ihr Master-Passwort ein."}</p>
    <div class="field"><label for="mp">${useCode ? "Code vom Notfallblatt" : "Master-Passwort"}</label>
      <div class="pw-wrap"><input class="inp" id="mp" name="secret" type="${useCode ? "text" : "password"}" autocomplete="off" ${useCode ? 'placeholder="XXXXX-XXXXX-XXXXX-XXXXX" style="text-transform:uppercase"' : ""} autofocus>
      ${useCode ? "" : `<button class="btn ghost" type="button" data-act="toggle-secret" data-for="mp">${ic("eye")}<span>Zeigen</span></button>`}</div></div>
    <p class="err" id="form-err" role="alert"></p>
    <button class="btn pri big" style="--accent:var(--ink);width:100%">${ic("unlock")}Öffnen</button>
    <p class="alt"><button class="linkbtn" type="button" data-act="toggle-code">${useCode ? "Doch das Master-Passwort verwenden" : "Passwort vergessen? Notfallblatt verwenden"}</button></p>
  </form></div>`;
}

export async function loadVault() {
  S.vault = normalizeVault(JSON.parse((await S.backend.vaultLoad()) || "{}"));
}

export async function lockVault() {
  await S.backend.vaultLock();
  S.vault = null;
  closeDialog();
}

act("toggle-code", () => {
  useCode = !useCode;
  render();
});
/** Show or hide the password fields named in data-for (space-separated ids, e.g. a field and its repetition). */
act("toggle-secret", (el) => {
  const inputs = el.dataset.for!.split(" ").map((id) => document.getElementById(id) as HTMLInputElement | null);
  const show = inputs[0]?.type === "password";
  for (const input of inputs) if (input) input.type = show ? "text" : "password";
  const label = el.querySelector("span");
  if (label) label.textContent = show ? "Verbergen" : "Zeigen";
});

form("unlock", async (v, f) => {
  const err = document.getElementById("form-err")!;
  if (!v.secret) return void (err.textContent = useCode ? "Bitte geben Sie den Code ein." : "Bitte geben Sie Ihr Master-Passwort ein.");
  const btn = f.querySelector("button.pri") as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (useCode) await S.backend.vaultUnlockCode(v.secret);
    else await S.backend.vaultUnlock(v.secret);
    await loadVault();
    const viaCode = useCode;
    useCode = false;
    render();
    if (viaCode) toast("Geöffnet. Legen Sie in den Einstellungen ein neues Master-Passwort fest.");
  } catch (e) {
    btn.disabled = false;
    err.textContent = useCode && e === "wrong_secret" ? "Dieser Code stimmt nicht. Bitte prüfen Sie jede Stelle." : errorText(e);
  }
});
