# nereo OS — CLAUDE.md

Zentrale Architektur- und Arbeitsanweisung für das **nereo OS** Monorepo.
Diese Datei ist die verbindliche Referenz für alle, die an diesem Repo arbeiten (Menschen und Claude).

---

## 1. Was ist nereo OS

Ein eigenständig auf einem **VPS** gehostetes Web-Tool für nereo development partners.
Es ist die **Intelligenz-, Bedien- UND Aktionsschicht** über den bestehenden Projektdaten — **kein zweiter Dokumentenspeicher**.

- **Dokumente bleiben in Microsoft 365 / SharePoint.** Dort ist und bleibt die Single Source of Truth.
- nereo OS **liest** diese Daten, zeigt Status, und lässt **KI-Agenten** definierte Analysen darauf laufen.
- nereo OS **schreibt auch gezielt zurück** in SharePoint/Outlook (Dateien, Ordner, Status-/Metadaten-Spalten, Mail) — aber **abgesichert**: Mensch-im-Loop (Dry-run-Default), lückenloses Audit-Log, Ops-Kill-Switch. **Keine** Dauerkopien — geschrieben wird in die SSoT selbst, nicht in einen Zweitspeicher.

Merksatz: **SharePoint speichert. nereo OS denkt, zeigt — und handelt (kontrolliert).**

---

## 2. Prinzipien

- **Keine zweite Dokumentenhaltung.** Die Original-Dokumente liegen ausschließlich in SharePoint. Persistiert werden nur App-State und abgeleitete Analyse-Daten — **niemals** Dauerkopien der Kundendokumente. Schreiben heißt: zurück in die SSoT (SharePoint), nicht in einen Zweitspeicher.
- **Schreiben ist erlaubt, aber abgesichert.** Jede Mutation gegen SharePoint/Outlook läuft ausschließlich über `graph-client → mutate()` und damit durch vier Guardrails: (1) Ops-Kill-Switch `GRAPH_WRITE_ENABLED`, (2) eingeloggter Actor, (3) **Dry-run-Default** — ohne `confirm=1` wird nichts ausgeführt (Mensch-im-Loop-Preview), (4) **lückenloses Audit-Log** (`graph_write_audit` in App-Postgres). Kein direkter Graph-Write am `mutate()`-Pfad vorbei.
- **KI-Tasks eng umrissen**, mit Quellenbezug, Mensch im Loop.

### Drei strikt getrennte Datenwelten
Wichtig — diese drei Speicher haben **nichts** miteinander zu tun:

| Speicher | Inhalt | Rolle |
|---|---|---|
| **SharePoint / M365** | Original-Kundendokumente | **Single Source of Truth.** nereo OS liest — und schreibt gezielt zurück (abgesichert, siehe Guardrails oben). Bleibt der einzige Dokumentenspeicher. |
| **App-Postgres** (self-hosted, Coolify, DB `nereo_app`) | Analyse-Ergebnisse + aus SharePoint abgeleitete/zwischengespeicherte Daten (Index, Metadaten, Agenten-Output) | **Zwischenspeicher / App-Daten.** Enthält **keine** Original-Dokumente, nur Abgeleitetes. *(Entscheidung 2026-06: self-hosted auf dem VPS statt Supabase — Daten bleiben auf dem VPS; getrennte DB von LogTo.)* |
| **LogTo-Postgres** (self-hosted, Coolify) | Identität, Logins, Sessions | **Nur Auth.** Hat mit den SharePoint-Daten **null** zu tun und sieht keine Projekt-/Analyse-Daten. |

### Go-Live-Constraints (institutionelle Investoren — später scharf zu schalten)
Kunden sind Pensionskassen/Versicherer → **Datenresidenz CH/EU** für VPS, DB und KI-Inferenz wird vor dem produktiven Rollout Pflicht.
**Aktueller Stand (Build-Phase): zurückgestellt.** Analyse läuft derzeit ohnehin über Claude. Vor institutionellem Go-Live nachziehen.

---

## 3. Komponenten / Services

Alle Services liegen in **einem Monorepo**, sauber getrennt. Auf Coolify ergeben sich **4 Deployments**:

| Deployment | Subdomain | Aufgabe |
|---|---|---|
| **landing** | Domain-Root (`nereo.ch`) | Extrem minimal — nur Markenname + Einstieg zum Login. |
| **app** | `app.` | Die eigentliche Anwendung: Frontend + Backend + KI-Agenten in einem. Status-Ansicht, Analysen starten, Ergebnisse lesen. |
| **auth** | `auth.` | **LogTo, self-hosted** — Login/Registrierung, Identität, Sessions. |
| **db** | (intern) | **Postgres für LogTo** (self-hosted) — nur Auth-Daten, siehe §2. |

> App-Daten/Analysen liegen in der **self-hosted App-Postgres** (Coolify, DB `nereo_app`) — getrennt von dieser `db` (= LogTo-Postgres). Siehe §2. *(Kein Supabase mehr — Entscheidung 2026-06.)*

> Domain steht noch nicht fest; `nereo.ch` bevorzugt.

### Auth / Session (im `app`-Service)
Die App ist ihr **eigener OIDC-Client** (Auth-Code + PKCE gegen LogTo) und hält eine **eigene Cookie-Session** (`nereo_app`, 7 Tage). Gegated wird rein über diese Session; LogTo wird nur bei `/login` befragt.
- **Logout muss BEIDES beenden:** (1) App-Session leeren (`req.session = null`) **und** (2) die LogTo-SSO-Session über `/oidc/session/end` **mit `id_token_hint`** (das `id_token` wird dafür beim Callback in der Session abgelegt) — sonst authentifiziert der nächste `/login` still durch.
- **Gegatete Antworten sind `Cache-Control: no-store`**, das Dashboard hat zusätzlich einen **bfcache-Guard** (`pageshow`+`persisted` → reload). Sonst zeigt der **Zurück-Button** nach dem Logout die gecachte Seite → wirkt fälschlich „noch eingeloggt" (realer Bug, 2026-06-18 behoben).

### Integrationen
- **Microsoft Graph** (nicht „Outlook API"): einheitliche API für SharePoint/Drive **und** Outlook/Mail. Lesen + **abgesichertes Schreiben** (siehe Guardrails §2). Azure-App `nereo_os` braucht dafür `Sites.ReadWrite.All` + `Mail.Send` (Application-Permission, Admin-Consent).
- **Starke Outlook-Integration:** Mail-Kontext lesen und mit Projekten/Datenräumen verknüpfen — und **Mail senden** fürs automatische Nachhaken (`Mail.Send`).
- **SharePoint-Sync:** liest Ordnerstrukturen und Dokumente **on demand**, hält keine Dauerkopie; speichert nur Links/Referenzen + abgeleitete Metadaten. Schreiben (Datei/Ordner/Metadaten) geht direkt in SharePoint zurück, nie in einen Zweitspeicher.
- **Write-Schicht:** `packages/graph-client/src/index.js` → `mutate()` + Helfer (`uploadFile`, `replaceFile`, `deleteItem`, `createFolder`, `renameItem`, `moveItem`, `updateListItemFields`, `setDriveItemFields`, `sendMail`). HTTP-Endpoints: `apps/app/src/server.js` unter `/api/write/*`. Audit: `graph_write_audit` (App-Postgres).

### Workspace-Navigation — „Business as Code" (im `app`-Service)
Die App **spiegelt die SharePoint-Struktur** ab einer **fixen Wurzel** wider und ist der Ausgangspunkt von allem.

- **Fixe Wurzel:** standardmäßig der Ordner **„nereo Development Partners"** (OneDrive `kienle@nereo.ch`). Aufgelöst in `packages/graph-client/src/workspace.js` → `resolveRoot()`: ENV-Pin (`WORKSPACE_ROOT_DRIVE_ID`+`WORKSPACE_ROOT_ITEM_ID`) bevorzugt, sonst Bootstrap über `WORKSPACE_ROOT_UPN`+`WORKSPACE_ROOT_FOLDER`, mit diagnostischer Degradation (Kandidaten statt Crash). *Die Wurzel ist NICHT der Drive-Root* — sonst wäre der private OneDrive sichtbar. Umzug (anderer Ordner / später SharePoint-Site) = reine ENV-Änderung. In **derselben** Datei liegen als EINE Datenort-Policy auch die sichtbaren **Gesellschaften** (`COMPANY_CONFIG`) und die **Ausschlüsse** (`EXCLUDE_CONFIG`/`isExcluded`) — siehe „Ausschlüsse + Gesellschaften-Erlaubnisliste" unten.
- **Live-Spiegelung:** Navigation läuft **live** über Graph (nicht aus dem gecachten Index), damit neue/umbenannte Ordner sofort erscheinen. Endpoints: `GET /api/workspace` (Wurzel + Sidebar-Sektionen), `GET /api/fs?path=<rel>` (Kinder einer Ebene + Breadcrumb + Capability). **id-basierter Abstieg** (`descend` via `childByName`) statt Pfad-Adressierung → Containment (kein Ausbruch aus dem Workspace, `driveId` server-fix) und sonderzeichen-immun.
- **Ordner→Funktion (`packages/graph-client/src/structure.js`):** deklarative `CAPABILITIES[]` (erste-Match-gewinnt): `workspace-root` → `dataroom`(per Name) → `projects` → `company` → `dataroom`(per Struktur) → `folder`. Je Capability eine andere View + Aktionen. Datenraum-Analyse dockt live an: `live-room.js` → `buildLiveRoom()` baut on-demand ein `room`-Objekt, dessen `path` exakt dem gecachten `dataroom_key` entspricht (Live- und Cache-Analyse teilen den Schlüssel).
- **Schreiben bleibt getrennt:** die Nav ist read-only; „Ordner/Datei erstellen" ist als Capability-Aktion sichtbar, aber **für später** (deaktiviert). Schreiben läuft ausschließlich über `/api/write/*` mit den Guardrails aus §2.
- **Realtime-Sync (Graph-Webhooks):** Änderungen in SharePoint halten den gecachten Index (KPIs/Datenraum-Liste) live. Webhook = NUR Trigger (`/api/graph/webhook`, clientState-abgesichert) → `clientState`-Check → dirty-Flag → 202 → entkoppelt: Delta-Query (`driveDelta`) → `isUnderRoot`-Filter → gezielter Re-Walk → Index-Merge (`sync.js`/`deltaThenRewalkAndSave`) → betroffene Datenräume als **veraltet markiert** (`last_change_at`); **KI-Analyse wird NICHT auto-neu gerechnet** (Token-Schutz), die UI fragt „neu analysieren?". **Self-Management (LIVE seit 2026-06-18, KEIN externer Scheduler):** die App hält die Subscription selbst am Leben — In-Process-Timer in `server.js`: Startup-Reconcile mit Retry-Backoff (self-bootstrap/-heal), Renewal-/Heil-Check alle 30 min, unabhängiger Delta-Poll alle 20 min (bootstrappt selbst bei fehlender Subscription-Zeile). Single-Flight über `graph_subscription.processing_at`-Lease (`claimSubscriptionForSync`/`claimDirtySubscription`). Watchdog in `/healthz` (`sync.expiration`/`lastSyncAt`). Tabellen: `graph_subscription`, `dataroom_analysis.last_change_at`.<br>**Betriebsregel:** `DATABASE_URL` zeigt auf den internen Coolify-Hostnamen (nur im Docker-Netz) → Bootstrap/Renewal/Poll laufen **nur in-app / im Container**, NICHT vom Host. Erst-Bootstrap lief über den HTTP-Trigger `GET /api/graph/renew` (Header `X-Graph-Cron`, Secret `GRAPH_CRON_SECRET`); die CLIs `graph:subscribe`/`graph:sync` bleiben manuelle Werkzeuge.<br>**✅ End-to-end validiert (2026-06-19) — abgeschlossen.** Direkt bei Graph gegengeprüft (nicht nur App-Sicht): genau **1** aktive Subscription `2302a041-8cd4-4539-81fe-f96b862fcb00` auf `/drives/<root-drive>/root` → `https://app.nereo-os.de/api/graph/webhook`, `expiration` in der Zukunft; Wurzel löst korrekt zu „nereo Development Partners" auf; Webhook-Handshake gibt den `validationToken` als `text/plain 200` zurück. **Live-Test:** Test-Ordner in der Wurzel angelegt (11:29:53) → von der App nach **~1,5 Min** aufgegriffen (`/healthz.sync.lastSyncAt` sprang von 11:19:15 auf 11:31:32 — **vor** dem ~20-Min-Routine-Poll ⇒ echter Webhook-Weg), Ordner danach gelöscht. **Schnell-Check künftig (10 Sek.):** `GET https://app.nereo-os.de/healthz` → `sync.expiration` muss **in der Zukunft** liegen und `sync.lastSyncAt` **aktuell** sein; beides ok ⇒ Echtzeit läuft. Einzige strukturelle Schwachstelle bleibt §5.5 (Wurzel hängt an Kienles OneDrive).

### App-Navigation (feste Shell, Vasco-Prototyp — 2026-09-28)
Die App hat eine **feste Seitenleiste** (nicht mehr die live gespiegelte SharePoint-Struktur als Einstieg). **Eine Quelle** für Seitenleiste UND Adressen: `NAV_ACTIVE`/`NAV_PREP` in `apps/app/src/server.js`; das Shell-Template ist `apps/app/src/public/dashboard.html` (Design-Tokens im `:root`, siehe „Design & Marke"). Server rendert Seitenleiste + Titel + Inhalt in die Platzhalter `<!--SIDEBAR-->`/`<!--TITLE-->`/`<!--MAIN-->`. Alle Seiten laufen über `requireAuth` (nicht angemeldet → `/login`); Login/Session unverändert.
- **Aktive Seiten** (echte, direkt aufrufbare Adressen, **vorerst ehrlich leer** — keine Beispieldaten): `/` Dashboard · `/projekte` · `/datenraeume` · `/reports`.
- **„In Vorbereitung"** (grau, anklickbar, je eigene Adresse `/modul/<slug>`, gemeinsame Platzhalter-Seite mit einem Satz): unternehmen, freigaben, vertraege, email, kalender, steuern, banking, legal, risiken, mitarbeiter, einstellungen.
- **Kopfzeile:** Eingabefeld „n. Commander" — ohne Funktion, Hinweis „in Vorbereitung".
- **`/workspace` ist eine Übergangsseite (Entscheidung Mike, 28.09.2026). Sie wird Grundlage der Seite „Datenräume" und danach entfernt.** Serviert `apps/app/src/public/workspace.html` = die **unveränderte** bisherige Live-Ansicht (die APIs `/api/workspace`,`/api/fs`,`/api/datarooms`,`/api/datarooms/analyze` bleiben aktiv). Gleich gegated wie alle Seiten; **nicht** in der Seitenleiste verlinkt.
- **✅ Ausschlüsse + Gesellschaften-Erlaubnisliste (Bauregel §2/§3 — umgesetzt 2026-09-28):** EINE zentrale Datenort-Policy in `packages/graph-client/src/workspace.js`, ENV-überschreibbar: `COMPANY_CONFIG` (sichtbare Gesellschaften an der Wurzel, in Anzeige-Reihenfolge — `nereo.Group`, `nereo.development`; je ein `site`-Platzhalter für den späteren Umzug auf eine eigene SharePoint-Teamsite je Gesellschaft; ENV `WORKSPACE_COMPANIES`) und `EXCLUDE_CONFIG` (`isExcluded()`: Name **beginnt mit** `90_Personal`/`_ZU_LOESCHEN`, **exakt** `.DS_Store`; ENV `WORKSPACE_EXCLUDE_PREFIXES`/`WORKSPACE_EXCLUDE_EXACT`). Der **Ausschluss sitzt im „einen Microsoft-Tor"** (`graph-client`): `listChildren`/`walkDrive`/`searchDrive`/`childByName` filtern zentral → `90_Personal…`/`_ZU_LOESCHEN…`/`.DS_Store` erscheinen **nirgends** (Nav, `/api/fs`, Suche, Index/Sync, KI) und sind auch per direkter Adresse nicht betretbar (`childByName`→`null`, `descend`→404). Die **Erlaubnisliste** greift an der Wurzel (`/api/workspace` → `pickCompanies`): nur die konfigurierten Gesellschaften erscheinen, `Projekte_alt`/`_VORLAGE_Gesellschaft` fallen weg. *Verifiziert 2026-09-28 read-only gegen die echte Ablage.*
- **⚠ Offen (Folgeschritt):** Die neue Ablage nummeriert anders (`01_Unternehmen`, `04_Projekte`) als die alte, nach der `structure.js` (`CAPABILITIES[]`) heute noch Ansichten zuordnet (`00_Unternehmen`, `01_Projekte`/`Projekte`). ⇒ Capability-Zuordnung auf die neue Nummerierung nachziehen (eigener Auftrag).

### KI-Agenten (im `app`-Service)
Definierte, eng umrissene Tasks — kein „KI auf alles":
- **Was fehlt noch?** (Vollständigkeit eines Datenraums)
- **Potenzielle Risiken** im Material
- **Unstimmigkeiten / Widersprüche** zwischen Dokumenten
- (erweiterbar: Zusammenfassung, Kennzahlen-Extraktion)

Output: strukturiert, mit **Quellenbezug**; Entscheidungs-Unterstützung mit Mensch im Loop.

### App-State / Analyse-Ergebnisse → App-Postgres (self-hosted, Coolify)
Die App schreibt ihre eigenen Daten — Analyse-Ergebnisse, Dokument-Index, Status, abgeleitete Metadaten aus SharePoint — in eine **dedizierte Postgres auf dem VPS** (Coolify, DB `nereo_app`). Dient als **Zwischenspeicher** für alles, was aus SharePoint analysiert wird.
**Enthält keine Original-Dokumente** (die bleiben in SharePoint) und **ist getrennt von der LogTo-DB** (siehe §2). *(Entscheidung 2026-06: self-hosted statt Supabase — Daten bleiben auf dem VPS, passt zur CH/EU-Datenresidenz.)*

### Design & Marke — Design-Tokens + Logos (LIVE seit 2026-09-28)
Helles nereo-CI (Vascos Klick-Prototyp): weiß/`#f7f7f7` + Schwarz + Türkis-Akzent. Umgesetzt in App-Dashboard + Startseite; **Login (LogTo) bleibt unangetastet** (Bauregel §1).

**Design-Tokens — zentrale Stelle je Instanz:** App im `:root` von `apps/app/src/public/dashboard.html`, Landing im Inline-Style von `apps/landing/src/server.js`. *Ein* verbindlicher Satz, in beiden **identisch**. Es gibt **keine** gemeinsame Laufzeit-Datei für alle drei Instanzen (Landing + App bauen als getrennte Container, Login = LogTo/extern) — eine geteilte Datei ginge nur mit Architektur-Änderung → verboten.
- Farben: Hintergrund `#f7f7f7` · Karten `#fff` · Schwarz (Text/Kopf/Primärknopf) `#000`, Fließtext `#111` · Linie `#dedede`/hell `#eeeeee` · gedämpft `#666`/`#8a8a8a` · **Akzent Türkis `#06eddb`** · Türkis weich `rgba(6,237,219,.12)`/sehr weich `…,.055`.
- Schatten Karten `0 8px 26px rgba(0,0,0,.055)`. Ecken **5px** (Karten/Knöpfe), **4px** (Listen/Etiketten) — keine Pillen, keine Verläufe.
- Schrift **Inter, self-hosted** (`inter.woff2`, variabel/latin) — **NICHT** Google Fonts (Datenschutz); je Instanz über `/inter.woff2` ausgeliefert. Grund 13px, `letter-spacing:-.005em`; Überschrift 23px/weight ~760.

**Logo-Ordner (einziger Ort):** SharePoint-CI `nereo Development Partners / nereo.development / 01_Unternehmen / 05_Strategie / 02_CI_Corporate_Identity / 02_Logo / 02_Export_SVG`. Verwendet: `Nereo_Logo_Black_ColorDot.svg` (Wortmarke + türkiser Punkt, auf Weiß) und `Nereo_n_Black.svg` (Favicon). Read-only über `graph-client → downloadItem()` geholt, dann in `apps/app/src/public/` bzw. `apps/landing/src/` abgelegt und per Route ausgeliefert. Lockup: kleine „nereo"-Wortmarke + **größeres** „OS" (Großbuchstaben, dünn) direkt neben dem Punkt, Unterkante bündig. **App-Seitenleiste WEISS** (nicht schwarz).

---

## 4. Deployment

- **Ein GitHub-Repo (Monorepo)**, klare Verzeichnis-Trennung pro Service.
- **4 Deployments auf Coolify:** `landing`, `app`, `auth` (LogTo), `db` (Postgres).
- Reverse Proxy / TLS über Coolify (Traefik).
- **DB-Backups** über Coolify einrichten (LogTo-DB = Identitätsspeicher, kritisch).
- **Deploy-Branch = `main`** (GitHub-App-Quelle `ml0711/nereo_OS`); `app` + `landing` bauen via Dockerfile, Healthcheck auf `/healthz` — durchgefallener Build ⇒ alter Container bleibt aktiv (Prod-Schutz).
- **Auto-Deploy läuft VPS-seitig, NICHT über GitHub** (Entscheidung 2026-06-18): Der GitHub-App-Webhook feuert nicht und ist nicht reparierbar (bei GitHub-App-Quellen kein Coolify-Auto-Deploy-Toggle, kein Zugang zum Kunden-GitHub). Ersatz: **cron (1×/Min) → `/home/deploy/nereo-autodeploy.sh`** beobachtet `origin/main` und stößt bei neuer SHA den Coolify-Deploy-API-Call für `app`+`landing` an (Token + State unter `~/.config/nereo-autodeploy/`). ⇒ **Jeder Push auf `main` deployt automatisch (~1 Min Verzögerung).**

### Vorgeschlagene Repo-Struktur
```
/apps
  /landing        # Domain-Root
  /app            # app.  — Frontend + Backend + KI-Agenten
/packages         # geteilter Code (Typen, Graph-Client, UI-Kit)
/infra            # Coolify-/Docker-Compose-Definitionen
docker-compose.yml
CLAUDE.md
```
(LogTo + Postgres laufen als eigene Container/Deployments, via Coolify provisioniert.)

---

## 5. Offene Punkte

1. **Wer registriert sich?** v1 = 3 Founder. Self-Service vs. invite-only. Externe Kunden-Logins später + strenger.
2. **Graph-Berechtigung (ENTSCHIEDEN 2026-06):** **`Sites.ReadWrite.All` tenant-weit** + `Mail.Send` — bewusst maximale Schreibmacht („Monster Tool"). *Consent-Stand:* `Files.ReadWrite.All` ist konsentiert (Drive-Datei-Writes funktionieren), **`Sites.ReadWrite.All` (Listen-/Status-Spalten) + `Mail.Send` (Versand) noch offen** → diese Writes laufen bis zum Admin-Consent ins 403. Read + Change-Notifications brauchen kein Write-Consent (laufen). *Trade-off:* tenant-weiter Write ist im Kunden-Security-Review angreifbar; vor institutionellem Go-Live ggf. auf `Sites.Selected`-mit-Write runterskalieren. Bis dahin tragen die App-Guardrails (Kill-Switch + Dry-run + Audit) das Risiko.
3. **Outlook-Scope (ENTSCHIEDEN):** Mail-Versand fürs Nachhaken aktiv → `Mail.Send`. Endpoint `/api/write/mail`. *(Mail-Kontext lesen + an Projekte/Datenräume knüpfen = Realtime-Phase 2, Wiederverwendung der Webhook-Infra — noch offen.)*
4. **Datenresidenz CH/EU** vor institutionellem Go-Live (zurückgestellt, siehe §2). App-DB ist bereits self-hosted auf dem VPS; vor Go-Live VPS-Standort + KI-Inferenz CH/EU prüfen.
5. **Workspace-Wurzel hängt an einer Einzelperson:** die Default-Wurzel „nereo Development Partners" liegt im OneDrive von `kienle@nereo.ch`. Verlässt er die Firma / zieht der OneDrive um → Wurzel + Realtime weg. Vor breiterem Rollout auf eine geteilte **SharePoint-Site/Bibliothek** umziehen — reine ENV-Änderung (`WORKSPACE_ROOT_*`).

---

## 6. Zugänge & Betriebs-Realität (verifiziert 2026-06-19)

**Single Source of Truth für Secrets = Coolify-Env je Deployment** (nicht das Repo-`.env` — das ist veraltet/leer). **Niemals Secret-Werte in CLAUDE.md, Memory oder Git** — hier stehen nur Pfade, IDs, Endpoints und der „eingerichtet/offen"-Status. Alle Zugangs-Artefakte liegen **host-lokal beim `deploy`-User auf dem VPS** und laufen über die Coolify-API (kein Docker-Exec: `deploy` hat **keinen** `docker.sock`-Zugriff).

| Zugang | Stand | Wo / wie |
|---|---|---|
| **GitHub** (Code → Deploy) | ✅ **Lesen + Schreiben** verifiziert (Test-Branch angelegt+gelöscht) | Repo `git@github.com:ml0711/nereo_OS.git`. Push-Key `~/.ssh/nereo_os_deploy` (in `git config core.sshCommand` gepinnt, `IdentitiesOnly`). **Push auf `main` ⇒ Auto-Deploy** via cron `~/nereo-autodeploy.sh` (~1 Min, siehe §4). Andere Branches deployen NICHT. |
| **Coolify** (Portal/Hosting) | ✅ **Voller Lese- + Deploy-Zugriff** verifiziert | API `http://localhost:8000/api/v1`, Token `~/.config/nereo-autodeploy/token`. Sichtbar/steuerbar: `app` (`o1dz93isw83ae51mh1fpj8s6`), `landing` (`x10xk0bm4dnddktdih5xil8z`), Service `auth`=LogTo (`jr743dc325bta845bftmfn30`), DB `app-db` (`ti9et3csd11h45pmuqz7dxy9`). Token ist aktions-fähig (löst Deploys aus); **Env-Schreiben** über die API gehört zum selben Token, wurde aber bewusst **nicht** an Prod getestet. |
| **LogTo** (Auth) | ✅ **Login aktiv · Management-API nutzbar — M2M-Secret in `.secrets.local`** | OIDC-Login läuft (`https://auth.nereo-os.de`, App = OIDC-Client: `LOGTO_APP_ID`/`LOGTO_APP_SECRET` in Coolify-`app`-Env). Admin-Konsole: `LOGTO_ADMIN_ENDPOINT` (in `auth`-Service-Env). **Die Management-API-M2M-App existiert bereits** (`coolify-automation`, App ID `s513vu2wm3fjdhmd0lq8x`, Rolle „Logto Management API access") — Ihr Secret wurde **2026-06-23 aus der LogTo-DB gelesen** und liegt **nur** in `/home/deploy/nereoos/.secrets.local` (gitignored). ⇒ **Claude kann User per Management-API anlegen** — siehe Unterabschnitt „User in LogTo anlegen" unten. Aktivieren: Secret hinterlegen (oder in der Admin-Konsole neu generieren) und als Coolify-`app`-Env setzen → Token via `POST /oidc/token` (Basic appId:secret, `grant_type=client_credentials`, `resource=https://default.logto.app/api`, `scope=all`) → `https://auth.nereo-os.de/api/...`. Bestand: 1 User `Letzgus` (`kcynpd2bl61r`), Self-Registration AUS. LogTo-DB-Creds in `auth`-Service-Env (DB `logto`), nur im Docker-Netz erreichbar. |
| **Microsoft Graph** | ✅ Lesen · ⚠️ Schreiben offen | App `nereo_os` (`MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` in Coolify-`app`-Env). Read + Change-Notifications laufen. Schreiben (`Sites.ReadWrite.All` + `Mail.Send`) **wartet auf Azure-Admin-Consent** → 403 (§5.2). Zusätzlich Kill-Switch `GRAPH_WRITE_ENABLED=0` ⇒ `/healthz.write=false`. |
| **App-DB** (`nereo_app`) | ✅ Creds bekannt · nur intern erreichbar | `DATABASE_URL` in Coolify-`app`-Env. Interner Coolify-Hostname ⇒ **nur im Docker-Netz / in-Container** erreichbar, NICHT vom VPS-Host (siehe §3 Betriebsregel). |
| **App-eigene KI** (`ANTHROPIC_API_KEY`) | ⏸️ **Bewusst AUS (Entscheidung 2026-06-19)** | Coolify-`app`-Env-Key ist absichtlich leer. **Die Datenraum-Analysen laufen vorerst über Claude Code (diese Session/Chat)** — read-only auf Struktur+Metadaten aus dem Index (`extractDataRooms` über `.data/graph-index.json` bzw. die `graph_index`-DB). Die eingebaute `apps/app/src/analyze.js` (würde Haiku 4.5 nutzen, identisches Schema 00–16 + ANALYSIS_SCHEMA) bleibt vorhanden, aber inaktiv, bis später ggf. ein Key gesetzt wird. **Getrennt** von „Claude Code". |

**Health-Probe:** `GET https://app.nereo-os.de/healthz` → `{status, db, write, sync:{expiration,lastSyncAt,dirty}}`. Stand 2026-06-19: alles `ok`, Realtime-Subscription lebt.

### Offene Schalter, um „voll arbeitsfähig" zu werden (Entscheidung nötig)
- **A — User per API anlegen:** ✅ **ERLEDIGT 2026-06-23.** M2M-Secret bekannt (liegt in `.secrets.local`); Claude kann User per Management-API anlegen — siehe Unterabschnitt „User in LogTo anlegen". (Optional noch offen: Secret zusätzlich als Coolify-`app`-Env, falls die App selbst User anlegen soll.)
- **B — App-KI scharf schalten (zurückgestellt 2026-06-19):** vorerst NICHT nötig — Analysen laufen über Claude Code (Chat). Später ggf. `ANTHROPIC_API_KEY` in Coolify-`app`-Env, dann analysiert die App auch ohne Chat selbst.
- **C — Graph-Schreiben scharf schalten (nur fürs Zurückschreiben/Mail — NICHT für Analysen):** **Lesen läuft bereits** ⇒ für die Analysen ist **kein** Microsoft-Consent nötig. Erst wenn die App Dateien/Ordner/Status zurück nach SharePoint schreiben oder Mails senden soll: Azure-Admin-Consent (`Sites.ReadWrite.All` + `Mail.Send`) + `GRAPH_WRITE_ENABLED=1`.

### User in LogTo anlegen — eingerichtet 2026-06-23 (Schalter A erledigt)
Läuft direkt über die **LogTo Management-API**; **kein** Admin-Portal nötig (`auth.nereo-os.de/console` bleibt separat kaputt: Admin-Backend Port 3002 nicht web-exponiert). **Geheimwerte stehen NUR** in der gitignored Datei **`/home/deploy/nereoos/.secrets.local`** (chmod 600, nur `deploy` — nie in Git/CLAUDE.md/Memory). Keys dort: `LOGTO_M2M_CLIENT_ID`, `LOGTO_M2M_SECRET` (App „coolify" = „coolify-automation", M2M, Rolle „Logto Management API access", tenant `default`), `LOGTO_TOKEN_ENDPOINT`, `LOGTO_MGMT_RESOURCE`, `LOGTO_API_BASE`, `DEPLOY_SUDO_PASSWORD`.

**Ablauf (nur HTTP, kein sudo/DB):**
1. Werte laden: `set -a; . /home/deploy/nereoos/.secrets.local; set +a`
2. Token: `POST $LOGTO_TOKEN_ENDPOINT` — HTTP-Basic `LOGTO_M2M_CLIENT_ID:LOGTO_M2M_SECRET`, Body `grant_type=client_credentials&resource=$LOGTO_MGMT_RESOURCE&scope=all` → `access_token` (gültig 3600 s).
3. Anlegen: `POST $LOGTO_API_BASE/users` (Header `Authorization: Bearer …`), JSON `{"primaryEmail":"…","name":"…","password":"…"}`. Liste/Check: `GET $LOGTO_API_BASE/users`.

**Notfall — Secret neu lesen, falls `.secrets.local` fehlt:** in der LogTo-DB (`logto`) die Zeile `id = s513vu2wm3fjdhmd0lq8x` der Tabelle `applications`, Spalte `secret` — via `sudo docker exec postgres-jr743dc325bta845bftmfn30 psql` (DB-User/-Passwort aus Container-Env `$POSTGRES_USER`/`$POSTGRES_PASSWORD`; sudo-Passwort = `DEPLOY_SUDO_PASSWORD`).

---

## 7. Bauregeln nereo.OS (Mike, 28.09.2026)

Verbindlich für alle künftigen Arbeiten an diesem Repo. Bei Konflikt mit einer Aufgabe gewinnt die Regel — dann nachfragen.

1. **Architektur nicht ändern.** Keine neue Datenbank, kein neuer Container/Dienst, keine Änderung an Anmeldung (LogTo), Microsoft-Berechtigungen, Coolify oder Domain. Braucht eine Aufgabe das → **stoppen** und einen **Auftrag für Ayham** formulieren (Ziel · Ist · Soll · Abnahme).
2. **Datenort an genau einer Stelle.** Wurzel der Ablage und ausgeschlossene Ordner stehen in EINER zentralen Einstellung (`workspace.js` / ENV), nie verteilt im Code.
3. **Ausschlüsse (immer, ausnahmslos):** jeder Ordner, dessen Name mit `90_Personal` beginnt (inkl. allem darunter), jeder Ordner ab `_ZU_LOESCHEN`, sowie Systemdateien wie `.DS_Store`. Der Ausschluss passiert **serverseitig, bevor Daten an den Browser gehen** — auch in Suche, Links, Zählungen, KI-Aufrufen und Fehlermeldungen.
4. **Lesen ist Lesen.** Funktionen schreiben NICHTS nach SharePoint/OneDrive, außer für genau diese Funktion ausdrücklich von Mike freigegeben. Nie überschreiben, nie löschen, nie verschieben.
5. **Ein Microsoft-Tor.** Alle Graph-Zugriffe laufen über die zentrale Stelle (`graph-client`), damit dort später eine Rechteprüfung ergänzt werden kann.
6. **Keine Geheimnisse in Repo-Dateien.** Keine echten Personaldaten als Testdaten.
7. **Arbeitsweise:** erst Plan in einfacher Sprache → auf Mikes OK warten → bauen. Nie ohne OK committen oder pushen. Nach dem Bauen: sagen, wie Mike es testet.
8. **Oberfläche auf Deutsch.** Design nach den **nereo-Design-Tokens** (helle CI, angelegt 2026-09-28 — siehe §3 „Design & Marke"): Akzent Türkis `#06eddb`, Inter self-hosted (kein Google Fonts), Ecken 5/4px, keine Verläufe.
9. **Struktur folgt `_KONVENTIONEN.md`** in der Ablage. Kennungen: Projekt-ID `JJJJ-NNN`, Analysekennungen `A00–A17` aus `_ANALYSEKATALOG.md`. Diese Dateien **lesen, nicht abschreiben**.
