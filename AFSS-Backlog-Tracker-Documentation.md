# AFSS Backlog Tracker — Project Documentation

**Version:** 2.0  
**Deployed at:** https://bryan-technical-afss-418420976784.australia-southeast1.run.app  
**GCP Project:** technical-afss  
**Last Updated:** June 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Pages & Features](#2-pages--features)
3. [Dashboard — Section-by-Section](#3-dashboard--section-by-section)
4. [Data Sources & Business Logic](#4-data-sources--business-logic)
5. [API Routes](#5-api-routes)
6. [Caching Strategy](#6-caching-strategy)
7. [Team Members](#7-team-members)
8. [Companies & Job Classification](#8-companies--job-classification)
9. [Deployment](#9-deployment)
10. [Automated Cache Warming](#10-automated-cache-warming)
11. [Environment Variables](#11-environment-variables)
12. [Tech Stack](#12-tech-stack)

---

## 1. Overview

The AFSS Backlog Tracker is an internal web dashboard that connects to SimPRO to give management a live, consolidated view of:

- **Backlog** — all CFSP audit jobs across three companies (RM AFSS, CHUBB/AFAC, AE Evac), broken down by status
- **Team supply** — remaining working hours per auditor for the current month, factoring in leave and public holidays
- **Technical Support Works** — non-audit billable work, invested time, and quality assurance activity scheduled to the tech team
- **AFAC Prospect Demand** — projected AFAC/CHUBB audit demand based on last year's schedule

The app is hosted on Google Cloud Run (Sydney region). All times and dates use **AEST (UTC+10)**.

---

## 2. Pages & Features

### Backlog Page (`/`)

The main jobs list. Displays all pending and in-progress CFSP audit jobs across all three companies in a filterable, sortable table.

- Filter by company, stage, status
- Click any row to open the job in SimPRO directly
- Shows job name, customer, site, due date, estimated hours, invoice amount, scheduled date, and assigned technicians

### Dashboard (`/dashboard`) and Dashboard NO DATACOM (`/dashboard2`)

A one-page management summary. Both dashboards show the same data. Dashboard2 excludes DATACOM cost-centre jobs from Other Billable counts.

Sections:
1. **Tech Team Works table** — job counts, hours, and invoice amounts grouped by status row and company column
2. **Technical Team Supply** — per-auditor hours remaining this month including public holidays
3. **Technical Support Works** — other billable work, invested time, and QA jobs
4. **AFSS Audits Supply vs Demand** — audit hours supply vs demand comparison
5. **AFAC Prospect Demand** — projected future AFAC/CHUBB demand
6. **Technical Works + Prospect Demand Supply vs Demand**
7. **Intercompany Work** — manually-entered intercompany hours (RM/AE/FIA)
8. **Overall Demand vs Supply** — combined totals

---

## 3. Dashboard — Section-by-Section

### 3.1 Tech Team Works Table

| Column | Description |
|---|---|
| Count of Job | Number of CFSP jobs in that status for that company |
| Sum of Est. Hours | Total estimated labour hours |
| Sum of Amounts | Total invoice value (ex-tax, or $330 default if blank) |

**Total Backlog as at end of period** — sums all jobs across all status rows and all companies, plus Technical Support Works hours and amounts.

**Month filter (top-right)** — filters the table to jobs whose scheduled date falls in the selected month. Defaults to "All".

#### Status Rows

| Row | Colour | Condition |
|---|---|---|
| Scheduled Awaiting to be Done | Green | Job has a confirmed scheduled date in SimPRO |
| Awaiting Client Info | Blue | Job Status Name contains "client" or "awaiting" |
| Tentative Awaiting Scheduling | Orange | Pending job with no scheduled date confirmed |
| Attendance Complete/Results To Be Released | Grey | Stage=Progress (companies 1 and 8), or Status contains "complete/released/attendance" |

> **Note for AE Evac (company 10):** Progress-stage jobs are treated as "Scheduled Awaiting to be Done" (if they have a date) or "Tentative" (if they do not) — because AE Evac uses Progress stage to mean "booked", not "done".

> **Sum of Est. Hrs for Attendance Complete:** Always shows **0** on both dashboards. Work in this row is already complete so estimated hours are not relevant.

---

### 3.2 Technical Team Supply

Shows remaining billable supply hours for each of the three AFSS auditors for the **current calendar month**.

| Column | Description |
|---|---|
| Jun (current month) | Hours left this month = net hours after leave and public holidays |
| Total Supply Hours | Full monthly hours (before leave deductions) |
| Roles | Each auditor's primary function |

**Public holidays** are fetched automatically from the NSW government holiday list (via date.nager.at API, filtered to AU-NSW). They are displayed as a red row and deducted from supply hours.

**Leave deduction:** Confirmed leave booked in SimPRO is subtracted from supply hours.

**Remaining working days logic:**
- Before 3:00 PM today → today counts
- From 3:00 PM onwards → today is excluded (work day is done)

---

### 3.3 Technical Support Works

Three columns of data, all billed at **$100/hour**, sourced automatically from SimPRO.

#### Other Billable Work Scheduled to Tech Teams

Mirrors SimPRO's **Schedule Breakdown report** exactly with these criteria:
- **Company:** Labrobin Pty Ltd TA Red Men Fire Protection (Company 1)
- **Staff:** Josh Roger, Muhammad Soban, Ryan Gordon, Tentative-Muhammad, TENTATIVE-RYAN G
- **Date range:** Today (AEST) → end of selected month (rolling daily). Past months show full month.
- **Job Stage:** Pending or Progress
- **Cost Centre:** 38 AFSS cost centres (matches SimPRO's Schedule Breakdown filter)
- **Customer:** External customers only (excludes Redmen Fire, AFAC, Adair Operation, Z SAFE)

#### Invested Time (Training / Courses / Non-Billable)

Same schedule criteria as Other Billable but **internal customers only**:
- Customers matching: Redmen Fire, AFAC, Adair Operation, Z SAFE

#### Quality Assurance — Overall Total of Jobs in SimPRO

- **What:** All Pending jobs in Company 1 assigned to "A Quality Assurance Officer"
- **Date filter:** Jobs with DueDate on or before end of selected month
- **Rate:** $100/hour

---

### 3.4 Intercompany Work

Manually entered by the user via the dashboard UI. Saved to `data/intercompany.json` in the Docker image.

| Row | Description |
|---|---|
| Total | Auto-computed sum of RM + AE + FIA (read-only) |
| RM | Hours assigned to RM for scheduling at their discretion |
| AE | Hours assigned to AE |
| FIA | Hours assigned to FIA |

> **Important:** This data is stored in the Docker image. Before every deploy, run the data sync commands (see Deployment section) to preserve the latest values.

---

### 3.5 AFAC Prospect Demand

Shows the projected AFAC/CHUBB audit demand based on Muhammad Soban's schedule from the **same calendar period last year**. Excludes internal "REDMEN FIRE" admin/study jobs.

- Admin can exclude specific dates via the **Exclude dates** input at the bottom
- Excluded dates are saved to `data/afac-exclusions.json` in the Docker image

---

## 4. Data Sources & Business Logic

### SimPRO Connection

All data comes from the SimPRO REST API v1.0 using a Bearer token. The base URL and token are stored as Cloud Run environment variables.

### CFSP Filter (AFSS Audits)

A job qualifies as a CFSP audit job if it has technician ID **1126** ("A CFSP ONLY") assigned to it. This filter applies to companies 1 and 10. Company 8 (CHUBB/AFAC) returns all jobs without filtering.

### Technical Support Works — AFSS Cost Centre Filter

The 38 AFSS cost centres used in SimPRO's Schedule Breakdown filter:

```
AFE AFEX Systems, AFE Aspirating Smoke Det Parts, AFE Income,
AFE Speech Intelligibility Testing, AFE Video Fire Servicing,
ALH Parts - Not Included in PM Contract,
Christadelphian Included in Comprehensive Package,
Consultancy - Block Plans, Contract Comprehensive Package,
Contracts 6 Monthly, Contracts Annual, Contracts Monthly, Contracts Quarterly,
DATACOM: Contracts, DATACOM - Door works, DATACOM: Electrical Detection Income,
DATACOM: Electrical Lights Income, DATACOM - Mech Air, DATACOM: Passive Income,
DATACOM: Portables Income, DATACOM: Water Income,
Electrical Detection & Maintenance, Electrical Light Installation & Maintenance,
Equipment Hire, EVC Service Attendance, Exclusions, Fuel Levy Income 2026,
Material Collection, Passive Income - Doors etc,
Portables Exting Recharge & Pressure Test, Portables Portables Division Income,
Portables Swap & Go Extinguishers, Quote Required -> Send to KAM, Safety Check,
Test Book Income, Water - Fire Pump Repairs, Water Flow Testing,
Water - Supression - Sprinklers - HYD - FHR
```

CC names are retrieved inline from the schedule block via `expand=CostCenter`. A hardcoded fallback list of known CC IDs (`KNOWN_AFSS_CC_IDS`) is used when the expand returns an empty name.

### Technical Support Works — Customer Split

After filtering by the 38 AFSS cost centres, blocks are split by customer:

| Customer contains | Goes to |
|---|---|
| REDMEN FIRE, AFAC, ADAIR OPERATION, Z SAFE | Invested Time |
| All others | Other Billable |

### Job Hour Estimation

```
Estimated hours = job.Totals.ResourcesCost.LaborHours.Estimate
If that is 0 or missing → default to 2 hours
```

### Job Price

```
Invoice amount = job.Total.ExTax
If that is 0 or missing → default to $330
```

### Public Holidays

Fetched automatically from `https://date.nager.at/api/v3/PublicHolidays/{year}/AU`, filtered to NSW only (global=true OR counties includes "AU-NSW"). NSW Bank Holiday (first Monday in August) is added programmatically. Cached permanently per year.

### Date/Time Timezone

All date calculations use **AEST (UTC+10)**. The server uses `new Date(Date.now() + 10 * 60 * 60 * 1000)` to get AEST time.

---

## 5. API Routes

| Route | Purpose | Cache TTL |
|---|---|---|
| `GET /api/data?company=N&stage=S` | Job list for one company/stage combo | 1 hour |
| `GET /api/data?company=N&stage=S&force=1` | Force refresh | — |
| `GET /api/leave` | Team leave schedule + public holidays | 1 hour |
| `GET /api/tech-support` | Technical Support Works stats (OB + IT + QA) | OB/IT: 5 min, QA: 1 hour |
| `GET /api/tech-support?force=1` | Force tech-support rebuild | — |
| `GET /api/tech-support?debug=list&year=Y&month=M` | Lists all blocks counted as OB and IT | No cache |
| `GET /api/afac-prospect` | AFAC Prospect Demand | 30 min |
| `GET /api/intercompany` | Intercompany hours | No cache |
| `POST /api/intercompany` | Save intercompany hours | — |
| `GET /api/afac-exclusions` | AFAC excluded dates | No cache |
| `POST /api/afac-exclusions` | Save excluded dates | — |
| `GET /api/warmup` | Pre-warms all caches | — |

### `/api/tech-support` response

```ts
{
  otherBillable:    { jobs: number; hours: number; amount: number };
  investedTime:     { jobs: number; hours: number; amount: number };
  qualityAssurance: { jobs: number; hours: number; amount: number };
}
```

---

## 6. Caching Strategy

### Storage

Caches are written to JSON files in the OS temp directory (`/tmp` on Cloud Run, or `CACHE_DIR` env var if set). Each section has its own versioned cache file.

### Cache Files and TTLs

| Cache | File pattern | TTL |
|---|---|---|
| AFSS Audits (per company/stage) | `/tmp/afss-v4-{company}-{stage}-cache.json` | 1 hour |
| Team leave | `/tmp/afss-leave-cache-v2.json` | 1 hour |
| Tech Support OB/IT | `/tmp/afss-tech-support-v84-{year}-{month}.json` | **5 minutes** |
| Tech Support QA | `/tmp/afss-qa-v1.json` | **1 hour** |
| AFAC Prospect | `/tmp/afss-afac-prospect-{year}-{month}.json` | 30 minutes |
| Public Holidays | `/tmp/afss-public-holidays-nsw-{year}.json` | Never expires |

### Cache Version Bumping

Every significant code change to `tech-support/route.ts` increments the cache version (e.g. v83 → v84). This ensures the new container ignores old cached data and builds fresh on startup.

### Startup Warmup

On every deploy, `instrumentation.ts` runs all four warmup functions **before accepting any traffic**:

```
warmAll()          → AFSS Audits (companies 1 and 8) — ~5-8 min — bottleneck
warmLeave()        → Leave + public holidays — ~10 sec
warmTechSupport()  → OB/IT + QA — ~15-20 sec
warmAfacProspect() → AFAC Prospect — ~30 sec
```

All run in parallel. The dashboard is not accessible until all four complete (~10-13 minutes after deploy). After warmup, all page loads are instant.

---

## 7. Team Members

| Name | SimPRO ID | Role |
|---|---|---|
| Muhammad Soban | 1581 | Primary APFS |
| Ryan Gordon | 15 | Mixed of Technical Support Works and Secondary APFS |
| Josh Roger | 1753 | Estimation / Office Management Time ETC |

**Tentative staff** — additionally includes any SimPRO staff whose name contains "tentative" AND ("muhammad" OR "ryan"). These match SimPRO's Schedule Breakdown "5 selected" technicians: Tentative-Muhammad and TENTATIVE-RYAN G.

Leave references tracked: **1** = Annual Leave, **2** = Sick/Personal Leave.

---

## 8. Companies & Job Classification

| Company ID | Name | SimPRO Company | Filter |
|---|---|---|---|
| 1 | RM AFSS | Company 1 | CFSP tech ID 1126 |
| 8 | CHUBB/AFAC AFSS | Company 8 | All jobs (no filter) |
| 10 | AE Evac Procedure Audits | Company 10 | CFSP tech ID 1126 |

**AE Evac rate:** $385/hour (shown in column header). All other companies: $330 default or actual invoice amount.

**Stages fetched:** `Pending` and `Progress` for each company.

---

## 9. Deployment

### Platform

Google Cloud Run, region: `australia-southeast1`  
Service name: `bryan-technical-afss`  
Project: `technical-afss`  
Min instances: 1 (container never scales to zero)

### Before every deploy — sync live data

Run these in PowerShell from the project root (`afss-backlog\`) to preserve manually-entered data:

```powershell
Invoke-WebRequest -Uri "https://bryan-technical-afss-418420976784.australia-southeast1.run.app/api/intercompany" -OutFile "data\intercompany.json"
Invoke-WebRequest -Uri "https://bryan-technical-afss-418420976784.australia-southeast1.run.app/api/afac-exclusions" -OutFile "data\afac-exclusions.json"
```

These save the live intercompany hours and AFAC excluded dates into the Docker image so they survive the deploy.

### Deploy command

```powershell
cd "C:\Users\Admin\.gemini\antigravity\scratch\afss backlog\afss-backlog"
gcloud run deploy bryan-technical-afss --source . --project=technical-afss --region australia-southeast1 --timeout=300 --min-instances=1 --quiet
```

### After deploy

Wait **10-13 minutes** for the startup warmup to complete. The dashboard will return a loading state during this time. Once warmup finishes, all data is pre-cached and pages load instantly.

### Traffic pinning

If a deploy needs to be rolled back:
```powershell
# Rollback to previous revision
gcloud run services update-traffic bryan-technical-afss --to-revisions=REVISION_ID=100 --region australia-southeast1

# Unpin (return to latest)
gcloud run services update-traffic bryan-technical-afss --to-latest --region australia-southeast1
```

---

## 10. Automated Cache Warming

The `/api/warmup` endpoint runs all warmup functions. It is called:
- **Automatically** on every container startup (via `instrumentation.ts`) — blocks traffic until complete
- **Manually** via the "Refresh now" button on the dashboard (force-refreshes all sections)

The Cloud Scheduler job (`afss-warmup-job`) is no longer the primary warmup mechanism since `--min-instances=1` keeps the container alive permanently. The scheduler serves as a fallback heartbeat.

---

## 11. Environment Variables

Set on the Cloud Run service:

| Variable | Description |
|---|---|
| `SIMPRO_BASE_URL` | SimPRO instance base URL (`https://redmen.simprosuite.com`) |
| `SIMPRO_TOKEN` | SimPRO API Bearer token |

---

## 12. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| UI | React 19, Tailwind CSS v4 |
| Hosting | Google Cloud Run (australia-southeast1) |
| Scheduling | Google Cloud Scheduler (heartbeat fallback) |
| Data source | SimPRO REST API v1.0 |
| Cache storage | OS temp directory (`/tmp` JSON files) |
| Build | Google Cloud Build (from Dockerfile) |
| Public holidays | date.nager.at API (NSW filter) |

---

## 13. Known SimPRO API Behaviour

| Behaviour | Notes |
|---|---|
| `DateFrom`/`DateTo` on schedule API | **Silently ignored** — always use `Date=YYYY-MM-DD` (single day) |
| Cost centre endpoints (`/costcentres/`) | All return 404 — use `expand=CostCenter` on schedule blocks instead |
| Rate limiting | Returns 429. Code retries with exponential backoff (1s → 2s → 4s → 8s…). Heavy deploys exhaust the limit; recovery takes 1–8 minutes |
| Stage field on jobs API | Returned as plain string ("Pending", "Progress") |
| Company 10 (AE Evac) | Excluded from warmup to avoid rate limit exhaustion after companies 1+8 |

---

*Documentation updated June 2026.*
