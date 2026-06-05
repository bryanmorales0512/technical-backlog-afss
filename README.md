# AFSS Backlog Tracker

Internal tool for Red Adair that pulls job data from SimPRO, enriches it with site and schedule details, and presents it across two views: a per-company backlog table and an aggregate analytics dashboard.

**Live site:** https://bryan-technical-afss-712513641417.australia-southeast1.run.app  
**Last updated:** June 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Environment Variables](#environment-variables)
5. [Local Development](#local-development)
6. [Pages](#pages)
7. [API Routes](#api-routes)
8. [SimPRO Integration](#simpro-integration)
9. [Caching Strategy](#caching-strategy)
10. [Business Logic](#business-logic)
11. [Deployment](#deployment)

---

## Overview

The app tracks CFSP (fire safety) jobs across three SimPRO companies:

| Company ID | Label |
|---|---|
| 1 | RM AFSS (Red Men) |
| 8 | CHUBB/AFAC AFSS |
| 10 | AE Evac Procedure Audits |

Jobs are filtered to those assigned to technician **A CFSP ONLY** (ID `1126`) for companies 1 and 10. Company 8 shows all jobs without a technician filter.

All times use **AEST (UTC+10)**.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI | React 19 + TypeScript 5 |
| Styling | Tailwind CSS v4 |
| Runtime | Node.js 20 |
| Hosting | Google Cloud Run (australia-southeast1) |
| Source data | SimPRO REST API v1.0 |
| Public holidays | date.nager.at API (NSW) |

---

## Project Structure

```
app/
  page.tsx                    # Main backlog table (/)
  dashboard/page.tsx          # Analytics dashboard (/dashboard)
  dashboard2/page.tsx         # Dashboard NO DATACOM (/dashboard2)
  globals.css                 # Tailwind base styles
  layout.tsx                  # Root HTML layout
  lib/
    simpro.ts                 # SimPRO API client, pooled fetching, disk cache
    gcsCache.ts               # GCS cache stub (disabled)
  api/
    data/route.ts             # AFSS Audits job data endpoint
    leave/route.ts            # Team leave schedule + public holidays
    tech-support/route.ts     # Technical Support Works (OB, IT, QA)
    afac-prospect/route.ts    # AFAC Prospect Demand
    intercompany/route.ts     # Intercompany work (manual entry)
    afac-exclusions/route.ts  # AFAC excluded dates (manual entry)
    extra-team/route.ts       # Extra team members
    warmup/route.ts           # Cache pre-warming
    webhook/simpro/route.ts   # SimPRO webhook handler
data/
  intercompany.json           # Persisted intercompany hours (sync before deploy)
  afac-exclusions.json        # Persisted AFAC excluded dates (sync before deploy)
instrumentation.ts            # Startup warmup (blocks traffic until cache is warm)
Dockerfile                    # Multi-stage Docker build
```

---

## Environment Variables

Create `.env.local` in the project root:

```env
SIMPRO_BASE_URL=https://redmen.simprosuite.com
SIMPRO_TOKEN=<bearer token>
```

Both variables are server-side only.

---

## Local Development

```bash
yarn install
yarn dev
```

Open http://localhost:3000.

---

## Pages

### `/` — Backlog Table

Displays a scrollable job table for the selected company and stage (Pending or Progress).

### `/dashboard` — Analytics Dashboard

Full analytics dashboard including all sections.

### `/dashboard2` — Dashboard (NO DATACOM)

Same as `/dashboard` but excludes DATACOM cost-centre jobs from Other Billable counts.

---

## API Routes

| Route | Purpose | TTL |
|---|---|---|
| `GET /api/data?company=N&stage=S` | AFSS Audits job list | 1 hour |
| `GET /api/leave` | Team leave + public holidays | 1 hour |
| `GET /api/tech-support` | OB + IT + QA stats | OB/IT: 5 min, QA: 1 hour |
| `GET /api/tech-support?force=1` | Force live rebuild | — |
| `GET /api/tech-support?debug=list&year=Y&month=M` | Full block list for debugging | No cache |
| `GET /api/afac-prospect` | AFAC Prospect Demand | 30 min |
| `GET /api/intercompany` | Intercompany hours | No cache |
| `POST /api/intercompany` | Save intercompany hours | — |
| `GET /api/afac-exclusions` | AFAC excluded dates | No cache |
| `POST /api/afac-exclusions` | Save excluded dates | — |
| `GET /api/warmup` | Warm all caches | — |

---

## SimPRO Integration

### Authentication

Every request sends:
```
Authorization: Bearer <SIMPRO_TOKEN>
Content-Type: application/json
```

### Rate Limiting

`simGet()` retries up to 6 times on HTTP 429 with exponential backoff (1s → 2s → 4s → 8s…). Heavy usage exhausts the SimPRO rate limit; recovery takes 1–8 minutes.

### Known API Quirks

| Issue | Workaround |
|---|---|
| `DateFrom`/`DateTo` silently ignored on schedules | Use `Date=YYYY-MM-DD` day-by-day |
| Cost centre endpoints return 404 | Use `expand=CostCenter` on schedule blocks |
| Stage field | Plain string ("Pending", "Progress") |

---

## Caching Strategy

| Cache | File | TTL |
|---|---|---|
| AFSS Audits (per company/stage) | `/tmp/afss-v4-{company}-{stage}-cache.json` | 1 hour |
| Leave + public holidays | `/tmp/afss-leave-cache-v2.json` | 1 hour |
| Tech Support OB/IT | `/tmp/afss-tech-support-v84-{year}-{month}.json` | 5 minutes |
| Tech Support QA | `/tmp/afss-qa-v1.json` | 1 hour |
| AFAC Prospect | `/tmp/afss-afac-prospect-{year}-{month}.json` | 30 minutes |
| Public Holidays | `/tmp/afss-public-holidays-nsw-{year}.json` | Never |

On every deploy, `instrumentation.ts` blocks all traffic until caches are warm (~10-13 minutes). After that, all page loads are instant.

---

## Business Logic

### Technical Support Works

Mirrors SimPRO's Schedule Breakdown report exactly:

- **Staff:** Josh Roger (15), Muhammad Soban (1581), Ryan Gordon (1753) + Tentative-Muhammad + TENTATIVE-RYAN G
- **Date range:** Today (AEST) → end of month. Past months: full month.
- **Job Stage:** Pending or Progress
- **Cost Centre:** 38 AFSS cost centres (CC name from `expand=CostCenter`, with KNOWN CC IDs as fallback)
- **Customer split:** Internal (Redmen Fire, AFAC, Adair, Z SAFE) → Invested Time. External → Other Billable.

### Attendance Complete Row

Sum of Est. Hrs always shows **0** — work in this row is already complete.

### Public Holidays

Auto-fetched from date.nager.at, filtered to NSW (AU-NSW). NSW Bank Holiday (first Monday August) added programmatically.

---

## Deployment

### Before every deploy — sync persistent data

Run in PowerShell from the `afss-backlog\` folder:

```powershell
Invoke-WebRequest -Uri "https://bryan-technical-afss-712513641417.australia-southeast1.run.app/api/intercompany" -OutFile "data\intercompany.json"
Invoke-WebRequest -Uri "https://bryan-technical-afss-712513641417.australia-southeast1.run.app/api/afac-exclusions" -OutFile "data\afac-exclusions.json"
```

### Deploy command

```powershell
gcloud run deploy bryan-technical-afss --source . --region australia-southeast1 --timeout=300 --min-instances=1 --quiet
```

### After deploy

Wait **10-13 minutes** for startup warmup to complete, then reload the dashboard.
