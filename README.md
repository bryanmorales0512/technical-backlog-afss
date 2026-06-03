# AFSS Backlog Tracker

Internal tool for Red Adair that pulls job data from SimPRO, enriches it with site and schedule details, and presents it across two views: a per-company backlog table and an aggregate analytics dashboard.

**Live site:** https://bryan-technical-afss-712513641417.australia-southeast1.run.app

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

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.6 (App Router) |
| UI | React 19.2.4 + TypeScript 5 |
| Styling | Tailwind CSS v4 |
| Runtime | Node.js 20 |
| Hosting | Google Cloud Run (australia-southeast1) |
| Source data | SimPRO REST API v1.0 |

---

## Project Structure

```
app/
  page.tsx                  # Main backlog table (/)
  dashboard/page.tsx        # Analytics dashboard (/dashboard)
  progress/page.tsx         # Legacy redirect → /
  globals.css               # Tailwind base styles
  layout.tsx                # Root HTML layout (Geist font)
  lib/
    simpro.ts               # SimPRO API client, pooled fetching, disk cache
  api/
    data/route.ts           # Main job data endpoint (smart cache)
    leave/route.ts          # Team leave schedule
    tech-support/route.ts   # Tech support work analytics
    warmup/route.ts         # Cache pre-warming (call after deploy)
    debug/route.ts          # Debug queries (tentative / scheduled / techs)
    jobs/route.ts           # Deprecated — not used by UI
    progress/route.ts       # Deprecated — not used by UI
Dockerfile                  # Multi-stage Docker build
next.config.ts              # Standalone output for containerised deploy
```

---

## Environment Variables

Create `.env.local` in the project root:

```env
SIMPRO_BASE_URL=https://redmen.simprosuite.com
SIMPRO_TOKEN=<bearer token>
```

Both variables are server-side only (never sent to the browser).

---

## Local Development

```bash
yarn install
yarn dev
```

Open http://localhost:3000.

The dev server hot-reloads on file changes. API routes run in the same process and use the same `/tmp` cache directory as production.

---

## Pages

### `/` — Backlog Table

Displays a scrollable job table for the selected company and stage (Pending or Progress).

**Controls:**
- **Company dropdown** — switches between RM AFSS, CHUBB/AFAC AFSS, AE Evac
- **Stage tabs** — Pending / Progress
- **Refresh now** — forces a cache bypass and full SimPRO re-fetch
- **Auto-poll** — refreshes data every 60 seconds in the background

**Columns vary by company and stage.** Common columns across all views:

| Column | Source |
|---|---|
| Job | SimPRO job ID |
| Status | `Status.Name` with color dot from `Status.Color` |
| Created Date | `DateIssued` |
| Customer | `Customer.CompanyName` or individual name |
| Site | `Site.Name` |
| Scheduled | `_scheduledDate` (see [Scheduled Date Priority](#scheduled-date-priority)) |
| Est. Hours | `Totals.ResourcesCost.LaborHours.Estimate` (defaults to 2 if zero) |
| Due Date | `DueDate` |
| Technicians | Comma-separated list from `Technicians[].Name` |
| Sell Price | `Total.ExTax` (defaults to $330 if zero) |
| Tags | Comma-separated list from `Tags[].Name` |

Additional columns for specific companies include Site Suburb, Site Postcode, Customer Group, Actual Hours, Job Type, Salesperson, Site Contact, and Notes (HTML stripped).

---

### `/dashboard` — Analytics Dashboard

Aggregate view with three sections:

#### Work Demand Table

Rows break down the full backlog by status across all three companies:

| Row | Colour | Condition |
|---|---|---|
| Total Backlog as at end of period | Purple | All visible jobs |
| Scheduled Awaiting to be Done | Green | Job has a `_scheduledDate` |
| Awaiting Client Info | Blue | Pending, no date |
| Tentative Awaiting Scheduling | Gold | No scheduled date |
| Attendance Complete / Results To Be Released | Gray | Progress stage (excl. mixed plan type) |

Each row shows **# of Jobs**, **Sum of Est. Hours**, and **Invoice Amount**.

A **month filter** dropdown (All / current month / +2 months) narrows results. Selecting a month also includes the previous month to align with the SimPRO Schedule Breakdown report.

#### Technical Team Supply

Shows net available hours per team member after deducting approved leave. Leave is sourced from `/api/leave`. Hours reset at midnight; the "remaining" calculation switches from today to tomorrow at 3 PM.

#### Technical Support Works

Three sub-sections, all billed at $100/hour:

| Section | Description |
|---|---|
| Other Billable Work | Jobs scheduled to the tech team this month, excluding AFSS audits and system-testing tagged jobs |
| Invested Time | Estimated workload of customers the team is currently serving (Pending jobs only) |
| Quality Assurance | All jobs (Pending + Progress) assigned to "A Quality Assurance Officer" |

---

## API Routes

### `GET /api/data`

Main job data endpoint with intelligent caching.

**Query parameters:**

| Param | Values | Default |
|---|---|---|
| `company` | `1`, `8`, `10` | `1` |
| `stage` | `Pending`, `Progress` | `Pending` |
| `force` | `0`, `1` | `0` |

**Response:** Array of enriched job objects (see [Data Model](#data-model)).

**Cache behaviour:**

| State | Action |
|---|---|
| Fresh cache (<5 min, complete) | Return immediately |
| Stale or partial cache | Return old data; refresh in background |
| Cold cache | Return basic list instantly; enrich in background |
| `force=1` | Bypass cache; full re-fetch; block until complete |

---

### `GET /api/leave`

Returns team leave schedules and monthly hours for the three technicians.

**Query parameters:** `force=1` bypasses the 1-hour cache.

**Response:**
```ts
[
  {
    id: number;
    name: string;
    role: string;
    monthlyHours: number;        // Total supply hours for the month
    leave: { from: string; to: string }[];  // ISO date ranges
  }
]
```

Scans SimPRO schedule blocks for activity type with References `"1"` (annual leave) or `"2"` (sick leave). Consecutive days (with weekend bridging and 1-day gap tolerance) are merged into single ranges.

Cache file: `/tmp/afss-leave-cache.json` — TTL: 1 hour.

---

### `GET /api/tech-support`

Returns the three Technical Support Works metrics.

**Query parameters:** `force=1` bypasses the 1-hour cache. `debug=1` returns raw diagnostic data.

**Response:**
```ts
{
  otherBillable:    { jobs: number; hours: number; amount: number };
  investedTime:     { jobs: number; hours: number; amount: number };
  qualityAssurance: { jobs: number; hours: number; amount: number };
}
```

Cache file: `/tmp/afss-tech-support-v18-cache.json` — TTL: 1 hour.

---

### `GET /api/warmup`

Pre-warms the data cache for all six company/stage combinations sequentially. Call this after a fresh deployment to avoid cold-cache latency on first user visit.

**Response:**
```ts
[{ company: number; stage: string; ok: boolean; ms: number }]
```

Max duration: 300 seconds.

---

### `GET /api/debug`

Diagnostic endpoint — not used by the UI.

**Query parameters:** `company` (number), `mode` (`tentative` | `scheduled` | `techs`).

---

## SimPRO Integration

All SimPRO calls go through `app/lib/simpro.ts`.

### Authentication

Every request sends:
```
Authorization: Bearer <SIMPRO_TOKEN>
Content-Type: application/json
```

The token is BOM-stripped on startup.

### Rate Limiting

`simGet()` retries up to 8 times on HTTP 429 with exponential backoff starting at 1 second.

### Data Model

A fully enriched job object contains the raw SimPRO fields plus these additions:

| Field | Type | Description |
|---|---|---|
| `_site` | object \| null | Full SimPRO site record (address, suburb, postcode, primary contact) |
| `_scheduledDate` | string \| null | Earliest scheduled date from schedule blocks (YYYY-MM-DD) |
| `_scheduledHours` | number | Sum of all schedule block hours for the job |
| `_customerGroup` | string | `Customer.Profile.CustomerGroup.Name` |

### Enrichment Process

For each company/stage combination, `fetchAndCache()` runs four parallel batched fetches (10 concurrent workers each):

1. **Job details** — full job object per job ID
2. **Site details** — full site object per unique site ID
3. **Schedule blocks** — all schedule blocks per job ID (up to 250)
4. **Customer details** — company or individual customer profile per unique customer

Results are merged into the base job list and written to disk cache.

### Scheduled Date Priority

The `_scheduledDate` field is resolved in this order:

1. First date from SimPRO schedule blocks (`Date` field)
2. `detail.Scheduled` / `detail.DateScheduled` / `detail.ScheduledDate` / `detail.DateBooked`
3. `null`

---

## Caching Strategy

All caches use the local filesystem (`/tmp`) which is ephemeral on Cloud Run — caches clear on container restart or new deployment.

| Cache | File | TTL |
|---|---|---|
| Job data (per company/stage) | `/tmp/afss-v4-{company}-{stage}-cache.json` | 5 minutes |
| Team leave | `/tmp/afss-leave-cache.json` | 1 hour |
| Tech support analytics | `/tmp/afss-tech-support-v18-cache.json` | 1 hour |

**Stale-while-revalidate pattern** (`/api/data`):
- Serve cached data immediately (even if stale or partial)
- Kick off background enrichment
- Next poll will see fresh data

After a deployment, visit `/api/warmup` to pre-populate all caches before sending users to the site.

---

## Business Logic

### Estimated Hours Default

If `Totals.ResourcesCost.LaborHours.Estimate` is zero or missing, the app defaults to **2 hours**. This applies everywhere hours are displayed or summed.

### Scheduled Hours (Dashboard)

For the "Scheduled Awaiting to be Done" dashboard row, hours come from `_scheduledHours` (actual scheduled blocks) if non-zero, otherwise from the estimate. This reflects what is actually booked rather than what was planned.

### Mixed Plan Type Filter

A job is excluded from the "Attendance Complete" row if it has **both** `A CFSP ONLY` and another `A …` plan-type technician. This prevents double-counting jobs that straddle two cost centres.

### Leave Deduction Timing

- Before 3 PM: today's hours are included in remaining supply
- At or after 3 PM: today is treated as consumed; supply starts from tomorrow

### Tech Support — Other Billable Exclusions

Jobs are excluded from "Other Billable Work" if:
- They have technician `A CFSP ONLY` (ID `1126`) — these are AFSS audit jobs tracked separately
- They have a tag whose name contains `"system testing"`

### Tech Support — Tentative Staff

In addition to the three named technicians (IDs `1581`, `15`, `1753`), schedule blocks for staff whose names contain `"tentative"`, `"training"`, or `"non-billable"` are included in Other Billable and Invested Time calculations.

---

## Deployment

### Build and deploy to Cloud Run

```bash
gcloud run deploy bryan-technical-afss \
  --source . \
  --region australia-southeast1 \
  --project buoyant-purpose-475203-t9 \
  --quiet
```

This uses Cloud Build to build the Docker image and deploys it to the existing Cloud Run service. The `--source .` flag uses the `Dockerfile` in the project root.

### Dockerfile (multi-stage)

```
Stage 1 (deps)     node:20-alpine — install yarn dependencies
Stage 2 (builder)  node:20-alpine — build Next.js standalone output
Stage 3 (runner)   node:20-alpine — run server.js on port 8080
```

`next.config.ts` sets `output: "standalone"` so the built image contains only the files needed to run the server.

### After deployment

Call the warmup endpoint to pre-populate caches:

```
GET https://bryan-technical-afss-712513641417.australia-southeast1.run.app/api/warmup
```

This takes up to 5 minutes and eliminates cold-cache latency for the first users.

### Environment variables on Cloud Run

Set via the Cloud Run console or `--set-env-vars` flag:

```
SIMPRO_BASE_URL=https://redmen.simprosuite.com
SIMPRO_TOKEN=<token>
```
