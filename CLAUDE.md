# nereo OS — CLAUDE.md

Zentrale Architektur- und Arbeitsanweisung für das **nereo OS** Monorepo.
Diese Datei ist die verbindliche Referenz für alle, die an diesem Repo arbeiten (Menschen und Claude).

---

## 1. Was ist nereo OS

Ein eigenständig auf einem **VPS** gehostetes Web-Tool für nereo development partners.
Es ist die **Intelligenz- und Bedienschicht** über den bestehenden Projektdaten — **kein Dokumentenspeicher**.

- **Dokumente bleiben in Microsoft 365 / SharePoint.** Dort ist und bleibt die Single Source of Truth.
- nereo OS **liest** diese Daten (read-only), zeigt Status, und lässt **KI-Agenten** definierte Analysen darauf laufen.
- nereo OS **editiert keine** SharePoint-Inhalte. Es referenziert sie über **Links**.

Merksatz: **SharePoint speichert. nereo OS denkt und zeigt.**

---

## 2. Prinzipien

- **Keine zweite Dokumentenhaltung.** Die Original-Dokumente liegen ausschließlich in SharePoint. Persistiert werden nur App-State und abgeleitete Analyse-Daten — **niemals** Dauerkopien der Kundendokumente.
- **Read-only gegenüber SharePoint.** Least privilege bei den Graph-Berechtigungen.
- **KI-Tasks eng umrissen**, mit Quellenbezug, Mensch im Loop.

### Drei strikt getrennte Datenwelten
Wichtig — diese drei Speicher haben **nichts** miteinander zu tun:

| Speicher | Inhalt | Rolle |
|---|---|---|
| **SharePoint / M365** | Original-Kundendokumente | **Single Source of Truth.** nereo OS liest nur (read-only). |
| **Supabase** (cloud Postgres) | Analyse-Ergebnisse + aus SharePoint abgeleitete/zwischengespeicherte Daten (Index, Metadaten, Agenten-Output) | **Zwischenspeicher / App-Daten.** Enthält **keine** Original-Dokumente, nur Abgeleitetes. |
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

> App-Daten/Analysen liegen in **Supabase** (extern, cloud) — nicht in diesem `db`-Deployment.

> Domain steht noch nicht fest; `nereo.ch` bevorzugt.

### Integrationen
- **Microsoft Graph** (nicht „Outlook API"): einheitliche API für SharePoint/Drive **und** Outlook/Mail. Read-only.
- **Starke Outlook-Integration:** Mail-Kontext lesen und mit Projekten/Datenräumen verknüpfen.
- **SharePoint-Sync:** liest Ordnerstrukturen und Dokumente **on demand**, hält keine Dauerkopie; speichert nur Links/Referenzen + abgeleitete Metadaten.

### KI-Agenten (im `app`-Service)
Definierte, eng umrissene Tasks — kein „KI auf alles":
- **Was fehlt noch?** (Vollständigkeit eines Datenraums)
- **Potenzielle Risiken** im Material
- **Unstimmigkeiten / Widersprüche** zwischen Dokumenten
- (erweiterbar: Zusammenfassung, Kennzahlen-Extraktion)

Output: strukturiert, mit **Quellenbezug**; Entscheidungs-Unterstützung mit Mensch im Loop.

### App-State / Analyse-Ergebnisse → Supabase (entschieden)
Die App schreibt ihre eigenen Daten — Analyse-Ergebnisse, Dokument-Index, Status, abgeleitete Metadaten aus SharePoint — in **Supabase** (cloud, Postgres). Dient als **Zwischenspeicher** für alles, was aus SharePoint analysiert wird.
**Enthält keine Original-Dokumente** (die bleiben in SharePoint) und **ist getrennt von der LogTo-DB** (siehe §2).

---

## 4. Deployment

- **Ein GitHub-Repo (Monorepo)**, klare Verzeichnis-Trennung pro Service.
- **4 Deployments auf Coolify:** `landing`, `app`, `auth` (LogTo), `db` (Postgres).
- Reverse Proxy / TLS über Coolify (Traefik).
- **DB-Backups** über Coolify einrichten (LogTo-DB = Identitätsspeicher, kritisch).

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
2. **Graph-Berechtigung:** `Sites.Selected` (nur freigegebene Sites) statt tenant-weitem `Sites.Read.All`.
3. **Outlook-Scope:** rein lesend — oder Mail-Versand fürs Nachhaken (= Schreibrecht)?
4. **Datenresidenz CH/EU** vor institutionellem Go-Live (zurückgestellt, siehe §2). Supabase: EU-Region wählen.
