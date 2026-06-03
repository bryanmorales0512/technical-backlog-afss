# AFSS Backlog Tracker — Project Documentation

**Version:** 1.0  
**Deployed at:** https://bryan-technical-afss-712513641417.australia-southeast1.run.app  
**GCP Project:** buoyant-purpose-475203-t9  
**Last Updated:** May 2026

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
- **Team supply** — remaining working hours per auditor for the current month, factoring in leave
- **Technical Support Works** — non-audit billable work, invested time, and quality assurance activity scheduled to the tech team

The app is hosted on Google Cloud Run (Sydney region) and updates automatically every 30 minutes via a Cloud Scheduler job.

---

## 2. Pages & Features

### Backlog Page (`/`)

The main jobs list. Displays all pending and in-progress CFSP audit jobs across all three companies in a filterable, sortable table.

- Filter by company, stage, status
- Click any row to open the job in SimPRO directly
- Shows job name, customer, site, due date, estimated hours, invoice amount, scheduled date, and assigned technicians

### Dashboard (`/dashboard`)

A one-page management summary with four sections:

1. **Tech Team Works table** — job counts, hours, and invoice amounts grouped by status row and company column
2. **Status rows** — Scheduled Awaiting to be Done / Awaiting Client Info / Tentative Awaiting Scheduling / Attendance Complete-Results To Be Released
3. **Technical Team Supply** — per-auditor hours remaining this month
4. **Technical Support Works** — other billable work, invested time, and QA jobs

---

## 3. Dashboard — Section-by-Section

### 3.1 Tech Team Works Table

| Column | Description |
|---|---|
| Count of Job | Number of CFSP jobs in that status for that company |
| Sum of Est. Hours | Total estimated labour hours |
| Sum of Amounts | Total invoice value (ex-tax, or $330 default if blank) |

**Total Backlog as at end of period** — sums all jobs across all status rows and all companies.

**Month filter (top-right)** — filters the table to show only jobs whose scheduled date falls in the selected month (also includes the prior month). Defaults to "All".

#### Status Rows

| Row | Colour | Condition |
|---|---|---|
| Scheduled Awaiting to be Done | Green | Job has a confirmed scheduled date in SimPRO |
| Awaiting Client Info | Blue | Job Status Name contains "client" or "awaiting" |
| Tentative Awaiting Scheduling | Orange | Pending job with no scheduled date confirmed |
| Attendance Complete/Results To Be Released | Grey | Stage=Progress (all companies except AE Evac), or Status contains "complete/released/attendance" |

> **Note for AE Evac (company 10):** Progress-stage jobs are treated as "Scheduled Awaiting to be Done" if they have a date, or "Tentative" if they do not — because AE Evac uses Progress stage to mean "booked", not "done".

#### Loading States

- While data is loading, **Scheduled** and **Tentative** rows show `—` (dashes) because the breakdown between the two cannot be determined until full schedule enrichment is complete.
- The amber **"Refreshing schedule data…"** indicator means the background enrichment is still running. Numbers resolve automatically within 1–2 minutes on a cold cache.
- On a warm cache (normal operation), the dashboard loads with correct numbers in under 2 seconds.

---

### 3.2 Technical Team Supply

Shows remaining billable supply hours for each of the three AFSS auditors for the **current calendar month**.

| Column | Description |
|---|---|
| May (current month) | Hours left this month = remaining working days × 8 hrs |
| Total Supply Hours | Same as the monthly figure (matches the SimPRO "end of period" concept) |
| Roles | Each auditor's primary function |

**Leave deduction:** If an auditor has confirmed leave booked in SimPRO this month, those days are subtracted from their supply hours. The note at the bottom of this section lists any leave on record for today or upcoming.

**Remaining working days logic:**
- Before 3:00 PM today → today counts
- From 3:00 PM onwards → today is excluded (work day is done)

---

### 3.3 Technical Support Works

Three columns of data, all sourced automatically from SimPRO:

#### Other Billable Work Scheduled to Tech Teams (100/hr)
- **What:** Jobs scheduled to Josh Roger, Muhammad Soban, Ryan Gordon (and their Tentative placeholders) **excluding** CFSP audit jobs and "system testing" tagged jobs
- **Date range:** Today → end of current month (rolling daily)
- **How:** Scans the SimPRO schedule day-by-day, collects all job-type blocks for those staff members

#### Invested Time (100/hr)
- **What:** Pending jobs belonging to customers who have work scheduled to the tech team during the same period
- **Date range:** Today → end of current month
- **How:** From schedule blocks, extracts the customer IDs of scheduled jobs, then finds all pending SimPRO jobs for those customers

#### Quality Assurance — Overall Total of Jobs in SimPRO (100/hr)
- **What:** All Pending + Progress company 1 jobs assigned to "A Quality Assurance Officer"
- **Date range:** Not date-filtered — shows the full current QA workload
- **How:** Fetches all jobs from company 1 filtered to that technician ID

---

## 4. Data Sources & Business Logic

### SimPRO Connection

All data comes from the SimPRO REST API v1.0 using a Bearer token. The base URL and token are stored as Cloud Run environment variables.

### CFSP Filter

A job qualifies as a CFSP audit job if it has technician ID **1126** ("A CFSP ONLY") assigned to it. This filter applies to companies 1 and 10. Company 8 (CHUBB/AFAC) returns all jobs without filtering.

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

### Scheduled Date Source

A job is considered "scheduled" if any of these exist:
1. A schedule block in the SimPRO schedules API for that job (preferred — most accurate)
2. `Scheduled`, `DateScheduled`, `ScheduledDate`, or `DateBooked` field in the job detail

---

## 5. API Routes

| Route | Purpose | Cache TTL |
|---|---|---|
| `GET /api/data?company=N&stage=S` | Job list for one company/stage combo | 1 hour |
| `GET /api/data?company=N&stage=S&force=1` | Force refresh (background; returns partial immediately) | — |
| `GET /api/leave` | Team leave schedule for current month | 1 hour |
| `GET /api/leave?force=1` | Force leave refresh | — |
| `GET /api/tech-support` | Technical Support Works stats | 1 hour |
| `GET /api/tech-support?force=1` | Force tech-support refresh | — |
| `GET /api/warmup` | Pre-warms all caches (called by Cloud Scheduler) | — |

### `/api/data` response fields (per job)

| Field | Source | Description |
|---|---|---|
| `_site` | Sites API | Full site object |
| `_scheduledDate` | Schedules API | ISO date string of first confirmed schedule block |
| `_scheduledHours` | Schedules API | Total scheduled hours across all blocks |
| `_customerGroup` | Customers API | Customer group name (e.g. "Government") |
| `_company` | Added by dashboard | Company ID (1, 8, or 10) |

### `X-Partial: 1` header

When the response contains jobs that have **not yet been enriched** with schedule, site, and customer data, the API returns this header. The dashboard detects it and automatically retries every 5 seconds until the header is absent.

---

## 6. Caching Strategy

### Storage

Caches are written to JSON files in the OS temp directory (`/tmp` on Cloud Run). Each company/stage combination has its own cache file.

### TTL

All caches expire after **1 hour**.

### Stale-while-revalidate

When a request arrives for stale or partial data:
1. The cached data is returned **immediately** (fast response to user)
2. A background refresh kicks off against SimPRO
3. The next request will get the fresh data

### Cold cache (no file at all)

1. The fast-path runs: job list is fetched from SimPRO and returned with `X-Partial: 1`
2. Background enrichment starts (fetching per-job details, schedules, sites, customers)
3. Enrichment takes 30–160 seconds depending on job count
4. Dashboard auto-retries every 5 seconds until enrichment completes

### Warmup

The `/api/warmup` endpoint runs all three cache types sequentially (job data) and in parallel (leave + tech-support). It is called:
- **Automatically** every 30 minutes by Cloud Scheduler
- **Manually** after any new deployment (by running the warmup PowerShell command)

---

## 7. Team Members

| Name | SimPRO ID | Role |
|---|---|---|
| Muhammad Soban | 1581 | Primary APFS |
| Ryan Gordon | 15 | Mixed of Technical Support Works and Secondary APFS |
| Josh Roger | 1753 | Estimation / Office Management Time ETC |

Leave references tracked: **1** = Annual Leave, **2** = Sick/Personal Leave.

---

## 8. Companies & Job Classification

| Company ID | Name | SimPRO Company | Filter |
|---|---|---|---|
| 1 | RM AFSS | Company 1 | CFSP tech ID 1126 |
| 8 | CHUBB/AFAC AFSS | Company 8 | All jobs (no filter) |
| 10 | AE Evac Procedure Audits | Company 10 | CFSP tech ID 1126 |

**AE Evac rate:** $385/hour (shown in column header). All other companies: $330 default or actual invoice amount.

**Stages fetched:** `Pending` and `Progress` for each company (6 total combinations).

---

## 9. Deployment

### Platform

Google Cloud Run, region: `australia-southeast1`  
Service name: `bryan-technical-afss`  
Project: `buoyant-purpose-475203-t9`

### Deploy command

```powershell
gcloud run deploy bryan-technical-afss `
  --source . `
  --region australia-southeast1 `
  --project buoyant-purpose-475203-t9 `
  --quiet
```

### After every deployment — warm the cache

```powershell
Invoke-WebRequest `
  -Uri "https://bryan-technical-afss-712513641417.australia-southeast1.run.app/api/warmup" `
  -TimeoutSec 310
```

This takes 3–5 minutes. All six company/stage caches will be populated before any user visits the dashboard.

### Build

The app is containerised via the `Dockerfile` at the project root. Cloud Run builds the container from source using Google Cloud Build.

---

## 10. Automated Cache Warming

A **Cloud Scheduler** job (`afss-warmup-job`) hits the warmup endpoint every 30 minutes:

- **Schedule:** `*/30 * * * *` (every half-hour, UTC)
- **Region:** `australia-southeast1`
- **Timeout:** 310 seconds
- **URL:** `https://bryan-technical-afss-712513641417.australia-southeast1.run.app/api/warmup`

This ensures that even if the Cloud Run instance is recycled (which wipes `/tmp`), the cache is always refreshed within 30 minutes, long before the 1-hour TTL expires. Under normal operation, users loading the dashboard will always get pre-cached data and see results in under 2 seconds.

---

## 11. Environment Variables

Set on the Cloud Run service (not in code):

| Variable | Description |
|---|---|
| `SIMPRO_BASE_URL` | SimPRO instance base URL (e.g. `https://example.simpro.co`) |
| `SIMPRO_TOKEN` | SimPRO API Bearer token |

---

## 12. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| UI | React 19, Tailwind CSS v4 |
| Hosting | Google Cloud Run (australia-southeast1) |
| Scheduling | Google Cloud Scheduler |
| Data source | SimPRO REST API v1.0 |
| Cache storage | OS temp directory (`/tmp` JSON files) |
| Build | Google Cloud Build (from Dockerfile) |

---

*Documentation generated May 2026. For issues or questions, contact the system administrator.*
