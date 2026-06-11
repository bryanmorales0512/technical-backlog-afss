# AFSS Backlog Tracker — System Overview

**Version:** 2.0  
**Last Updated:** June 2026  
**Live URL:** https://bryan-technical-afss-712513641417.australia-southeast1.run.app  
**Owner:** Red Adair — Technical AFSS Team  
**Contact:** bryan.morales@redadair.com.au

---

## Table of Contents

### For Everyone
1. [What Is This System?](#1-what-is-this-system)
2. [What Problem Does It Solve?](#2-what-problem-does-it-solve)
3. [What Does It Automate?](#3-what-does-it-automate-plain-english)
4. [Who Can Use It?](#4-who-can-use-it)
5. [How to Log In](#5-how-to-log-in)
6. [Pages at a Glance](#6-pages-at-a-glance)

### For Technical Staff
7. [Architecture Overview](#7-architecture-overview)
8. [Tech Stack](#8-tech-stack)
9. [What Gets Automated — Technical Detail](#9-what-gets-automated--technical-detail)
10. [API Routes Reference](#10-api-routes-reference)
11. [Caching Strategy](#11-caching-strategy)
12. [Authentication & Access Control](#12-authentication--access-control)
13. [Environment Variables](#13-environment-variables)
14. [Deployment Process](#14-deployment-process)
15. [Data Files](#15-data-files)

---

# FOR EVERYONE

---

## 1. What Is This System?

The **AFSS Backlog Tracker** is an internal web dashboard built for Red Adair's fire safety compliance team. It gives management and technical staff a single, always-up-to-date view of every CFSP (Combined Fire Safety Provisions) audit job across three of the company's operating entities:

| Entity | What They Do |
|---|---|
| **RM AFSS** (Red Men) | Primary AFSS audit team |
| **CHUBB / AFAC** | AFAC-branded audit stream |
| **AE Evac** | Evacuation procedure audits |

Think of it as a live "job board" combined with a capacity planner — showing not just what work exists, but also how much time the team has left to do it this month.

---

## 2. What Problem Does It Solve?

Before this system existed, answering these questions required manually logging into SimPRO (Red Adair's job management software) and pulling separate reports:

- How many audit jobs are still in the backlog?
- Which jobs are scheduled vs. unscheduled?
- How many available hours does the team have left this month?
- How much non-audit technical support work is also scheduled?
- What is the expected AFAC audit demand over the coming weeks?

The AFSS Backlog Tracker **pulls all of that data automatically** and presents it in one place, refreshed throughout the day — so management can make staffing and scheduling decisions without manual report-pulling.

---

## 3. What Does It Automate? (Plain English)

Here is every task the system performs automatically on your behalf:

### Job Data Collection
Every hour, the system quietly connects to SimPRO and downloads the latest list of pending and in-progress CFSP audit jobs for all three companies. You never have to manually export or refresh a report.

### Team Availability Calculation
The system works out how many billable hours each auditor has left in the current month by:
- Starting with their standard working hours
- Subtracting any approved leave they have booked in SimPRO
- Subtracting NSW public holidays for the current month

This gives a real, usable capacity number — not a theoretical one.

### Technical Support Work Tracking
The system monitors the jobs scheduled to the tech team that are not CFSP audits (e.g., internal billable work, quality assurance tasks). It automatically categorises each job as:
- **Other Billable** — work billed to external customers
- **Invested Time** — internal work (Redmen Fire, AFAC, Adair, Z SAFE)
- **QA** — quality assurance activity

### AFAC Demand Forecasting
The system looks at what AFAC/CHUBB audit work Muhammad Soban was doing at the same time last year and uses that as a forecast for the coming weeks. This helps the team anticipate demand spikes before they arrive.

### Instant Updates When Schedules Change
When someone changes a schedule in SimPRO, SimPRO sends an automatic notification to this system. The system then refreshes its data in the background so the next time you load the dashboard, the numbers are already up to date. No manual action needed.

### Login Security
The system automatically checks that anyone trying to log in is a member of the approved Red Adair Google Workspace group. People outside that group cannot access the dashboard, even if they have a Google account.

---

## 4. Who Can Use It?

Access is restricted to members of the Google Workspace group:
`technicalafss-deployment@redadair.com.au`

If you need access, ask your administrator to add your Red Adair Google account to that group.

---

## 5. How to Log In

1. Open the live URL in your browser.
2. You will see a login page — click **Sign in with Google**.
3. Choose your `@redadair.com.au` Google account.
4. If your account is in the approved group, you will be taken straight to the dashboard.
5. If access is denied, contact your administrator.

> **Note:** After a new deployment, the system takes approximately 10–13 minutes to warm up its data. During that time the dashboard may be slow or show a loading state. This is normal.

---

## 6. Pages at a Glance

| Page | URL | What It Shows |
|---|---|---|
| **Backlog** | `/` | Full list of all pending and in-progress audit jobs, filterable by company, stage, and status. Click any row to open the job directly in SimPRO. |
| **Dashboard** | `/dashboard` | Management summary: job counts, team hours, technical support work, and AFAC demand forecast. |
| **Dashboard (No DATACOM)** | `/dashboard2` | Same as Dashboard but excludes DATACOM cost-centre jobs from the Other Billable totals. |
| **Progress** | `/progress` | Progress tracking view. |

---

# FOR TECHNICAL STAFF

---

## 7. Architecture Overview

```
Browser  →  Next.js App Router (Cloud Run, australia-southeast1)
                │
                ├── Middleware: Auth gate (NextAuth + Google Workspace group check)
                │
                ├── Pages: React 19 + Tailwind CSS v4
                │
                └── API Routes (14 endpoints)
                        │
                        ├── SimPRO REST API v1.0  (primary data source)
                        ├── date.nager.at          (NSW public holidays)
                        ├── Google Workspace API   (group membership)
                        └── Disk cache (/tmp or CACHE_DIR)
```

**Deployment platform:** Google Cloud Run (Node.js 22 / Alpine Linux)  
**Container:** Multi-stage Docker build (deps → builder → runner)  
**Output mode:** Next.js standalone  
**Cache headers:** `no-store` on all responses (caching is handled server-side, not by the browser)

---

## 8. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | 16 |
| UI Library | React | 19 |
| Styling | Tailwind CSS | v4 |
| Language | TypeScript | 5 |
| Runtime | Node.js (Alpine) | 22 |
| Authentication | NextAuth | v4 |
| Auth Provider | Google OAuth 2.0 + Workspace Directory API | — |
| Primary Data | SimPRO REST API | v1.0 |
| Holiday Data | date.nager.at | — |
| Cloud Platform | Google Cloud Run | — |
| Containerisation | Docker (multi-stage Alpine) | — |
| PDF Generation | Puppeteer | — |

---

## 9. What Gets Automated — Technical Detail

### 9.1 Cache Warming on Startup (`instrumentation.ts`)

On every Cloud Run deployment, the `instrumentation.ts` file runs **before the server accepts any traffic**. It pre-warms all caches sequentially to prevent slow first loads:

1. Fetch SimPRO job data for Company 1 (RM AFSS)
2. Wait 60 seconds (SimPRO rate limit recovery)
3. Fetch SimPRO job data for Company 8 (CHUBB/AFAC)
4. Warm leave schedule, technical support, and AFAC prospect data in parallel

Company 10 is excluded from warmup due to SimPRO rate limit constraints.  
Total warmup time: **10–13 minutes**.

### 9.2 SimPRO Webhook Integration (`/api/webhook/simpro`)

SimPRO sends a POST to `/api/webhook/simpro` whenever a schedule event changes. The handler:
1. Clears tech support cache files from disk
2. Kicks off a background rebuild of fresh tech support data
3. Returns 200 immediately — the rebuild runs asynchronously

### 9.3 Team Availability Calculation (`/api/leave`)

- Fetches leave records for three technicians: Muhammad Soban (ID 1581), Ryan Gordon (ID 15), Josh Roger (ID 1753)
- Fetches NSW public holidays from `date.nager.at` for the current year (cached permanently on disk)
- Fallback: hardcoded NSW holidays for 2025–2026 if the API is unreachable
- Calculates remaining hours = (working days remaining in month − leave days − public holiday days) × daily hours

### 9.4 Technical Support Work Categorisation (`/api/tech-support`)

Mirrors SimPRO's "Schedule Breakdown" report exactly. For each scheduled block in the tech team's calendar:
- Filters by 38 defined AFSS cost centre IDs
- Classifies customer type:
  - **Internal** (Redmen Fire, AFAC, Adair, Z SAFE) → Invested Time
  - **External** → Other Billable
  - **QA cost centres** → Quality Assurance

Cache TTLs: OB/IT = 5 minutes, QA = 1 hour.  
Force rebuild: append `?force=1`  
Debug export: `/api/tech-support?debug=list&year=Y&month=M`

### 9.5 AFAC Prospect Demand Forecasting (`/api/afac-prospect`)

- Uses Muhammad Soban's schedule from the same date range last year as a proxy for expected demand
- Supports date exclusions stored in `data/afac-exclusions.json`
- Cache TTL: 30 minutes
- Returns: job count, estimated hours, and date range

### 9.6 SimPRO Rate Limit Handling

SimPRO enforces strict per-token rate limits (HTTP 429). The app implements:
- Exponential backoff: 1s → 2s → 4s → 8s → … up to 8 retry attempts
- Sequential company fetches (not parallel) during warmup to avoid rate limit exhaustion

### 9.7 Authentication Middleware (`middleware.ts`)

All routes except `/login` and `/api/auth/*` are gated. The middleware:
1. Checks for a valid NextAuth session cookie
2. Validates that the user's email is a member of `technicalafss-deployment@redadair.com.au` via the Google Workspace Directory API
3. Uses a service account (`afss-group-checker@technical-afss.iam.gserviceaccount.com`) with subject impersonation for Directory API calls

---

## 10. API Routes Reference

| Endpoint | Method | Description | Cache TTL |
|---|---|---|---|
| `/api/data?company=N&stage=S` | GET | AFSS audit job list from SimPRO | 1 hour |
| `/api/data?force=1` | GET | Force live rebuild of job cache | — |
| `/api/leave` | GET | Team leave + NSW public holidays | 1 hour |
| `/api/tech-support` | GET | OB / IT / QA stats | 5 min (OB/IT), 1 hr (QA) |
| `/api/tech-support?force=1` | GET | Force rebuild of tech support cache | — |
| `/api/tech-support?debug=list&year=Y&month=M` | GET | Full schedule block list (no cache) | — |
| `/api/afac-prospect` | GET | AFAC prospect demand forecast | 30 min |
| `/api/afac-exclusions` | GET / POST | Read or update AFAC excluded dates | No cache |
| `/api/intercompany` | GET / POST | Read or update intercompany hours | No cache |
| `/api/extra-team` | GET | Team member metadata | — |
| `/api/extra-team/search` | GET | Search team members | — |
| `/api/jobs` | GET | Job detail | — |
| `/api/progress` | GET | Progress tracking data | — |
| `/api/warmup` | GET | Manually trigger full cache warm | — |
| `/api/webhook/simpro` | POST / GET | SimPRO schedule change webhook | — |
| `/api/auth/[...nextauth]` | GET / POST | NextAuth OAuth callbacks | — |

**Company parameter values:** `1` = RM AFSS, `8` = CHUBB/AFAC, `10` = AE Evac  
**Stage parameter values:** `Pending`, `Progress`

---

## 11. Caching Strategy

All caching is disk-based. In development the cache location defaults to `os.tmpdir()`. In production the `CACHE_DIR` environment variable points to a GCS-mounted volume for persistence across container restarts.

| Cache | File Pattern | TTL |
|---|---|---|
| AFSS audit jobs | `/tmp/afss-v4-{company}-{stage}-cache.json` | 1 hour |
| Team leave + holidays | `/tmp/afss-leave-cache-v2.json` | 1 hour |
| Tech support OB/IT | `/tmp/afss-tech-support-v84-{year}-{month}.json` | 5 minutes |
| Tech support QA | `/tmp/afss-qa-v1.json` | 1 hour |
| AFAC prospect demand | `/tmp/afss-afac-prospect-{year}-{month}.json` | 30 minutes |
| NSW public holidays | `/tmp/afss-public-holidays-nsw-{year}.json` | Permanent (never evicted) |

> GCS cache (`gcsCache.ts`) is present in the codebase but currently disabled. Disk cache is the active layer.

---

## 12. Authentication & Access Control

| Step | Mechanism |
|---|---|
| Login | Google OAuth 2.0 via NextAuth v4 |
| Group check | Google Workspace Directory API (`admin.googleapis.com`) |
| Allowed group | `technicalafss-deployment@redadair.com.au` |
| Service account | `afss-group-checker@technical-afss.iam.gserviceaccount.com` |
| Admin impersonation | `bryan.morales@redadair.com.au` |
| Session storage | NextAuth JWT (cookie-based) |
| Middleware scope | All routes except `/login` and `/api/auth/*` |

---

## 13. Environment Variables

```env
# SimPRO
SIMPRO_BASE_URL=https://redmen.simprosuite.com
SIMPRO_TOKEN=<bearer token>

# Google OAuth (NextAuth)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# NextAuth
NEXTAUTH_SECRET=...
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_URL_PRODUCTION=https://<cloud-run-url>

# Google Workspace service account
GOOGLE_SERVICE_ACCOUNT_EMAIL=afss-group-checker@technical-afss.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----...
GOOGLE_ADMIN_EMAIL=bryan.morales@redadair.com.au

# Optional — production only
CACHE_DIR=/path/to/gcs-volume
```

---

## 14. Deployment Process

### Pre-deploy (sync persistent data from production)

```powershell
Invoke-WebRequest -Uri "https://<prod-url>/api/intercompany" -OutFile "data\intercompany.json"
Invoke-WebRequest -Uri "https://<prod-url>/api/afac-exclusions" -OutFile "data\afac-exclusions.json"
git add data/
git commit -m "Sync persistent data before deploy"
```

### Deploy

```bash
gcloud run deploy bryan-technical-afss \
  --source . \
  --region australia-southeast1 \
  --timeout=300 \
  --min-instances=1 \
  --quiet
```

### Post-deploy

- Wait **10–13 minutes** for `instrumentation.ts` warmup to complete
- Reload the dashboard to confirm data is showing correctly
- Check Cloud Run logs if the warmup appears to stall

### Local Development

```bash
npm install
cp .env.local.example .env.local   # fill in credentials
npm run dev                        # starts on http://localhost:3000
```

---

## 15. Data Files

The following JSON files are stored in the `data/` directory and tracked in git. They hold state that must survive between deployments.

| File | Purpose | Editable Via |
|---|---|---|
| `data/intercompany.json` | Intercompany hours for RM, AE, and FIA | Dashboard UI or `POST /api/intercompany` |
| `data/afac-exclusions.json` | Dates excluded from AFAC demand forecasts | Dashboard UI or `POST /api/afac-exclusions` |
| `data/extra-team-members.json` | Supplementary team metadata | Direct file edit, then redeploy |

> Because Cloud Run containers are ephemeral, any data written to `/tmp` at runtime is lost on restart. These three files are the only state that must be synced before each deployment (see Section 14 — Pre-deploy steps).

---

## Key Business Rules (Quick Reference)

| Rule | Detail |
|---|---|
| Job filter — Companies 1 & 10 | Only jobs assigned to technician "A CFSP ONLY" (ID 1126) |
| Job filter — Company 8 | All jobs, no technician filter |
| Default job price | $330 if SimPRO total is blank |
| Invoice display | Ex-tax amounts |
| Status — Progress (Co 1 & 8) | Attendance complete (grey) |
| Status — Progress (Co 10 AE Evac) | Audit booked but not yet complete |
| Status — Scheduled | Job has a scheduled date set (green) |
| Status — Awaiting Client Info | Blue |
| Status — Tentative | Yellow |
| Timezone | All dates/times in AEST (UTC+10) |
| Cost centre count | 38 AFSS cost centres mapped by ID |

---

*This document covers both operational and technical aspects of the AFSS Backlog Tracker. For deployment history see git log. For SimPRO API reference see the SimPRO developer portal.*
