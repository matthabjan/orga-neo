// Reminder pop-up: large, with a sound, and it stays until answered.

import { ic } from "../icons";
import { Occurrence, ageOn, dueReminders, fmt, occKey, relDay, relLower, startTime } from "../model";
import { S, esc, render, saveOpen } from "../state";
import { category, catStyle } from "./cal";

const snoozed = new Map<string, number>();
let current: Occurrence | null = null;

function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880, 660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.28;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      osc.start(t);
      osc.stop(t + 0.27);
    });
    setTimeout(() => void ctx.close(), 1600);
  } catch {
    /* no sound available */
  }
}

export function checkReminders() {
  const box = document.getElementById("rem") as HTMLDialogElement;
  if (box.open || S.view === "setup") return;
  const now = new Date();
  const due = dueReminders(S.data, now).find((o) => (snoozed.get(occKey(o)) ?? 0) <= now.getTime());
  if (!due) return;
  current = due;
  const start = startTime(due);
  const rel = relDay(due.date, now);
  const when = rel ? `${relLower(due.date, now)}, ${fmt(due.date, { weekday: "long" })}` : fmt(due.date, { weekday: "long", day: "numeric", month: "long" });
  const title = due.contact ? `${due.contact.name} hat Geburtstag` : due.ev.title;
  const line = due.contact ? `wird ${ageOn(due.contact, due.date)} Jahre alt` : due.ev.time ? `${due.ev.time} Uhr` : "Ganztägig";
  const late = !due.contact && start.getTime() < now.getTime() && due.ev.time;
  box.innerHTML = `<div class="remind">
    <div class="rbell" style="${catStyle(due.ev.cat, "solid")}" aria-hidden="true">${ic(due.contact ? "cake" : "bell")}</div>
    <p class="rwhen">${late ? "Hat schon begonnen: " : "Erinnerung für "}${esc(when)}</p>
    <h2>${esc(title)}</h2>
    <p class="rtime">${esc(line)}</p>
    ${due.ev.place ? `<p class="rplace">${ic("pin")}${esc(due.ev.place)}</p>` : `<p class="rplace">${esc(category(due.ev.cat)?.name ?? "")}</p>`}
    <div class="ract"><button class="btn sec big" value="later">In 1 Stunde nochmal</button><button class="btn pri big" style="--accent:var(--ink)" value="done" autofocus>Erledigt</button></div>
  </div>`;
  box.returnValue = "later";
  box.showModal();
  chime();
  void S.backend.bringToFront().catch(() => {});
}

export function initReminders() {
  const box = document.getElementById("rem") as HTMLDialogElement;
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b) box.close(b.value);
  });
  box.addEventListener("close", () => {
    if (!current) return;
    if (box.returnValue === "done") {
      S.data.done[occKey(current)] = true;
      saveOpen();
    } else snoozed.set(occKey(current), Date.now() + 3_600_000);
    current = null;
    render();
    setTimeout(checkReminders, 800);
  });
  setInterval(checkReminders, 30_000);
  setTimeout(checkReminders, 2_000);
}
