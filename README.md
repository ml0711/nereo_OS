# nereo OS

Intelligenz- und Bedienschicht über den Projektdaten von nereo development partners.
SharePoint bleibt Single Source of Truth — nereo OS liest (read-only), zeigt Status und lässt KI-Agenten Analysen laufen.

> **Architektur & Prinzipien: siehe [CLAUDE.md](./CLAUDE.md).**

## Monorepo-Struktur
```
/apps
  /landing   Domain-Root — minimale Landingpage + Login-Einstieg
  /app       app. — Frontend + Backend + KI-Agenten
/packages    geteilter Code (Graph-Client, Typen, UI)
/infra       Coolify- / Docker-Compose-Definitionen (LogTo + Postgres)
```

## Datenwelten (strikt getrennt)
- **SharePoint / M365** — Original-Dokumente (SSOT), read-only.
- **Supabase** (cloud Postgres) — Analyse-Ergebnisse & abgeleitete Daten. Keine Original-Dokumente.
- **LogTo-Postgres** (self-hosted) — nur Auth. Hat mit den SharePoint-Daten nichts zu tun.

## Deployment
4 Coolify-Deployments: `landing`, `app`, `auth` (LogTo), `db` (Postgres für LogTo).

## Lokal starten
```bash
cp .env.example .env   # Werte eintragen
npm install
npm run dev            # startet die App(s)
```
