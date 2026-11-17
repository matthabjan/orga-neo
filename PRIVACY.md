# Privacy

*Deutsche Fassung weiter unten.*

Orga-Neo is built so that your data stays with you. There are no accounts, no
advertising, no analytics and no tracking.

## What is stored, and where

Everything you enter stays on your own computer, in the folder
`Documents\Orga-Neo`:

- Appointments, contacts, notes and settings are stored **unencrypted**, so that
  reminders can appear without asking for your password.
- Passwords and documents are stored **encrypted** with your master password.
- The program also keeps a log file for troubleshooting in
  `%LOCALAPPDATA%\io.github.matthabjan.organeo\logs`. It contains technical
  messages, not your entries, and it never leaves your computer.

Orga-Neo never sends any of this to the developer or anyone else.

## The update check

Orga-Neo checks for a new version on **GitHub** (`github.com`), shortly after it
starts and when you click "Nach Updates suchen". It downloads a small file that
describes the newest version and, if you choose to update, the installer.

Like any website, GitHub sees your IP address and basic technical information
about the request. No personal data and nothing you entered in Orga-Neo is sent.
GitHub's handling of this is described in the
[GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

You can turn off the automatic check in **Einstellungen › Programm**. You can
still search for updates by hand.

## Other components outside Orga-Neo's control

- **Microsoft WebView2**, part of Windows, displays Orga-Neo's window. Microsoft
  may collect diagnostic data through it according to your Windows settings and
  the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).
- **OneDrive or other backup services:** if your `Documents` folder is synced to
  a cloud service, the Orga-Neo folder is synced with it. Passwords and documents
  remain encrypted there; appointments, contacts and notes do not.

## Files you create yourself

Exports (calendar, contacts, notes, passwords as CSV, copies of documents) and the
printed recovery sheets are **not encrypted**. Keep them as carefully as you would
the original papers.

## Contact

Questions about privacy: please open an issue at
<https://github.com/matthabjan/orga-neo/issues>.

---

# Datenschutz

Orga-Neo ist so gebaut, dass Ihre Daten bei Ihnen bleiben. Es gibt kein Konto,
keine Werbung, keine Auswertung Ihrer Nutzung und keine Verfolgung.

**Was wo gespeichert wird:** Alles, was Sie eingeben, bleibt auf Ihrem Computer im
Ordner `Dokumente\Orga-Neo`. Termine, Kontakte, Notizen und Einstellungen sind
**nicht verschlüsselt**, damit Erinnerungen ohne Passwort erscheinen. Passwörter
und Dokumente sind mit Ihrem Master-Passwort **verschlüsselt**. Eine Protokolldatei
für die Fehlersuche liegt unter
`%LOCALAPPDATA%\io.github.matthabjan.organeo\logs`; sie enthält technische
Meldungen, nicht Ihre Einträge. Nichts davon wird an den Entwickler oder an andere
geschickt.

**Suche nach Updates:** Orga-Neo fragt kurz nach dem Start und wenn Sie auf „Nach
Updates suchen“ klicken bei **GitHub** nach einer neuen Version. Dabei sieht
GitHub, wie bei jeder Webseite, Ihre IP-Adresse und technische Angaben zur Anfrage.
Persönliche Daten oder Ihre Einträge werden nicht übertragen. Die automatische
Suche lässt sich unter **Einstellungen › Programm** ausschalten.

**Andere Bestandteile:** Das Programmfenster nutzt **Microsoft WebView2**, einen
Teil von Windows; dafür gelten Ihre Windows-Einstellungen und die
Datenschutzerklärung von Microsoft. Wird Ihr Ordner „Dokumente“ mit OneDrive oder
einem anderen Cloud-Dienst abgeglichen, gilt das auch für den Orga-Neo-Ordner.
Passwörter und Dokumente bleiben dort verschlüsselt, Termine, Kontakte und Notizen
nicht.

**Selbst erstellte Dateien:** Exporte und die gedruckten Notfallblätter sind
**nicht verschlüsselt**. Bewahren Sie sie so sorgfältig auf wie die Originalpapiere.

**Fragen:** bitte über <https://github.com/matthabjan/orga-neo/issues>.
