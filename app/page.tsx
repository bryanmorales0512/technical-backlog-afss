"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

const COMPANIES = [
  { id: 1,  label: "REDMEN OPERATION" },
  { id: 10, label: "ADAIR OPERATIONS" },
  { id: 8,  label: "AFAC" },
] as const;

type CompanyId = (typeof COMPANIES)[number]["id"];

const STAGES = ["Pending", "Progress"] as const;
type Stage = (typeof STAGES)[number];

const HEADERS = [
  "Job", "Status", "Created Date", "Customer", "Site",
  "Scheduled", "Est. Hours", "Due Date", "Technicians",
  "Sell Price", "Tags", "Site Suburb", "Actual Hours",
  "Customer Group", "Site Postcode", "Description", "Notes",
];

const HEADERS_AFAC_PENDING = [
  "Job", "Status", "Created Date", "Customer", "Site",
  "Scheduled", "Est. Hours", "Due Date", "Salesperson", "Technicians",
  "Sell Price", "Tags", "Site Suburb", "Job Type",
];

const HEADERS_AFAC_PROGRESS = [
  "Job", "Status", "Created Date", "Customer", "Site",
  "Scheduled", "Est. Hours", "Due Date", "Salesperson", "Technicians",
  "Sell Price", "Tags",
];

const HEADERS_ADAIR_PENDING = [
  "Job", "Created Date", "Due Date", "Scheduled",
  "Customer", "Site", "Site Contact", "Est. Hours",
  "Technicians", "Sell Price", "Tags",
  "Site Suburb", "Site State", "Site Postcode",
];

const HEADERS_ADAIR_PROGRESS = [
  "Job", "Created Date", "Due Date", "Scheduled",
  "Customer", "Site", "Technicians", "Sell Price",
  "Site Address", "Site State",
];

const POLL_MS = 60_000;

type RawJob = Record<string, unknown>;

function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

// Convert "YYYY-MM-DD" → "DD/MM/YYYY"
function fmtDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}


function techNames(job: RawJob): string {
  const t = job.Technicians;
  if (!Array.isArray(t)) return "";
  return t.map((x: unknown) => s((x as Record<string, unknown>)?.Name)).filter(Boolean).join(", ");
}

function tagNames(job: RawJob): string {
  const t = job.Tags;
  if (!Array.isArray(t)) return "";
  return t.map((x: unknown) => s((x as Record<string, unknown>)?.Name)).filter(Boolean).join(", ");
}

function dotColor(job: RawJob): string {
  return s((job.Status as Record<string, unknown>)?.Color) || "#94a3b8";
}

function jobToRowAFACPending(job: RawJob): string[] {
  const site        = (job.Site        ?? {}) as Record<string, unknown>;
  const siteDetail  = (job._site       ?? {}) as Record<string, unknown>;
  const address     = (siteDetail.Address ?? {}) as Record<string, unknown>;
  const customer    = (job.Customer    ?? {}) as Record<string, unknown>;
  const status      = (job.Status      ?? {}) as Record<string, unknown>;
  const total       = (job.Total       ?? {}) as Record<string, unknown>;
  const totals      = (job.Totals      ?? {}) as Record<string, unknown>;
  const resCost     = (totals.ResourcesCost ?? {}) as Record<string, unknown>;
  const labHours    = (resCost.LaborHours   ?? {}) as Record<string, unknown>;
  const salesperson = (job.Salesperson ?? {}) as Record<string, unknown>;

  const custName     = s(customer.CompanyName) || `${s(customer.GivenName)} ${s(customer.FamilyName)}`.trim();
  const scheduledRaw = s(job._scheduledDate) || s(job.Scheduled) || s(job.DateScheduled) || s(job.ScheduledDate) || s(job.DateBooked);
  const estRaw       = labHours.Estimate != null ? Number(labHours.Estimate) : null;
  const estHours     = estRaw != null && estRaw > 0 ? String(estRaw) : "2";

  return [
    s(job.ID),                                    // Job
    s(status.Name ?? job.Stage),                  // Status
    fmtDate(s(job.DateIssued)),                   // Created Date
    custName,                                     // Customer
    s(site.Name),                                 // Site
    scheduledRaw ? fmtDate(scheduledRaw) : "",    // Scheduled
    estHours,                                     // Est. Hours
    fmtDate(s(job.DueDate)),                      // Due Date
    s(salesperson.Name),                          // Salesperson
    techNames(job),                               // Technicians
    `$${Number(total.ExTax ?? 0).toFixed(2)}`,   // Sell Price
    tagNames(job),                                // Tags
    s(address.City),                              // Site Suburb
    s(job.Type as string),                        // Job Type
  ];
}

function jobToRowAFACProgress(job: RawJob): string[] {
  const site        = (job.Site        ?? {}) as Record<string, unknown>;
  const siteDetail  = (job._site       ?? {}) as Record<string, unknown>;
  const address     = (siteDetail.Address ?? {}) as Record<string, unknown>;
  const customer    = (job.Customer    ?? {}) as Record<string, unknown>;
  const status      = (job.Status      ?? {}) as Record<string, unknown>;
  const total       = (job.Total       ?? {}) as Record<string, unknown>;
  const totals      = (job.Totals      ?? {}) as Record<string, unknown>;
  const resCost     = (totals.ResourcesCost ?? {}) as Record<string, unknown>;
  const labHours    = (resCost.LaborHours   ?? {}) as Record<string, unknown>;
  const salesperson = (job.Salesperson ?? {}) as Record<string, unknown>;

  const custName     = s(customer.CompanyName) || `${s(customer.GivenName)} ${s(customer.FamilyName)}`.trim();
  const scheduledRaw = s(job._scheduledDate) || s(job.Scheduled) || s(job.DateScheduled) || s(job.ScheduledDate) || s(job.DateBooked);
  const estRaw       = labHours.Estimate != null ? Number(labHours.Estimate) : null;
  const estHours     = estRaw != null && estRaw > 0 ? String(estRaw) : "2";

  return [
    s(job.ID),                                                   // Job
    s(status.Name ?? job.Stage),                                 // Status
    fmtDate(s(job.DateIssued)),                                  // Created Date
    custName,                                                    // Customer
    s(site.Name),                                                // Site
    scheduledRaw ? fmtDate(scheduledRaw) : "",                   // Scheduled
    estHours,                                                    // Est. Hours
    fmtDate(s(job.DueDate)),                                     // Due Date
    s(salesperson.Name),                                         // Salesperson
    techNames(job),                                              // Technicians
    `$${Number(total.ExTax ?? 0).toFixed(2)}`,                  // Sell Price
    tagNames(job),                                               // Tags
  ];
}

function jobToRowADAIRPending(job: RawJob): string[] {
  const site        = (job.Site        ?? {}) as Record<string, unknown>;
  const siteDetail  = (job._site       ?? {}) as Record<string, unknown>;
  const address     = (siteDetail.Address ?? {}) as Record<string, unknown>;
  const customer    = (job.Customer    ?? {}) as Record<string, unknown>;
  const total       = (job.Total       ?? {}) as Record<string, unknown>;
  const totals      = (job.Totals      ?? {}) as Record<string, unknown>;
  const resCost     = (totals.ResourcesCost ?? {}) as Record<string, unknown>;
  const labHours    = (resCost.LaborHours   ?? {}) as Record<string, unknown>;
  const contact     = (siteDetail.PrimaryContact ?? {}) as Record<string, unknown>;

  const custName     = s(customer.CompanyName) || `${s(customer.GivenName)} ${s(customer.FamilyName)}`.trim();
  const scheduledRaw = s(job._scheduledDate) || s(job.Scheduled) || s(job.DateScheduled) || s(job.ScheduledDate) || s(job.DateBooked);
  const estRaw       = labHours.Estimate != null ? Number(labHours.Estimate) : null;
  const estHours     = estRaw != null && estRaw > 0 ? String(estRaw) : "2";

  return [
    s(job.ID),                                                   // Job
    fmtDate(s(job.DateIssued)),                                  // Created Date
    fmtDate(s(job.DueDate)),                                     // Due Date
    scheduledRaw ? fmtDate(scheduledRaw) : "",                   // Scheduled
    custName,                                                    // Customer
    s(site.Name),                                                // Site
    `${s(contact.GivenName)} ${s(contact.FamilyName)}`.trim(),  // Site Contact
    estHours,                                                    // Est. Hours
    techNames(job),                                              // Technicians
    `$${Number(total.ExTax ?? 0).toFixed(2)}`,                  // Sell Price
    tagNames(job),                                               // Tags
    s(address.City),                                             // Site Suburb
    s(address.State),                                            // Site State
    s(address.PostalCode),                                       // Site Postcode
  ];
}

function jobToRowADAIRProgress(job: RawJob): string[] {
  const site       = (job.Site     ?? {}) as Record<string, unknown>;
  const siteDetail = (job._site    ?? {}) as Record<string, unknown>;
  const address    = (siteDetail.Address ?? {}) as Record<string, unknown>;
  const customer   = (job.Customer ?? {}) as Record<string, unknown>;
  const total      = (job.Total    ?? {}) as Record<string, unknown>;

  const custName     = s(customer.CompanyName) || `${s(customer.GivenName)} ${s(customer.FamilyName)}`.trim();
  const scheduledRaw = s(job._scheduledDate) || s(job.Scheduled) || s(job.DateScheduled) || s(job.ScheduledDate) || s(job.DateBooked);
  const siteAddr  = s(address.Address);
  const siteState = s(address.State);

  return [
    s(job.ID),                                                   // Job
    fmtDate(s(job.DateIssued)),                                  // Created Date
    fmtDate(s(job.DueDate)),                                     // Due Date
    scheduledRaw ? fmtDate(scheduledRaw) : "",                   // Scheduled
    custName,                                                    // Customer
    s(site.Name),                                                // Site
    techNames(job),                                              // Technicians
    `$${Number(total.ExTax ?? 0).toFixed(2)}`,                  // Sell Price
    siteAddr,                                                    // Site Address
    siteState,                                                   // Site State
  ];
}

function jobToRow(job: RawJob): string[] {
  const site      = (job.Site     ?? {}) as Record<string, unknown>;
  const siteDetail= (job._site    ?? {}) as Record<string, unknown>;
  const address   = (siteDetail.Address ?? {}) as Record<string, unknown>;
  const customer  = (job.Customer ?? {}) as Record<string, unknown>;
  const status    = (job.Status   ?? {}) as Record<string, unknown>;
  const total     = (job.Total    ?? {}) as Record<string, unknown>;
  const totals    = (job.Totals   ?? {}) as Record<string, unknown>;
  const resCost   = (totals.ResourcesCost ?? {}) as Record<string, unknown>;
  const labHours  = (resCost.LaborHours   ?? {}) as Record<string, unknown>;
  const custGroup = (customer.CustomerGroup ?? job.CustomerGroup ?? {}) as Record<string, unknown>; // fallback only

  const custName     = s(customer.CompanyName) || `${s(customer.GivenName)} ${s(customer.FamilyName)}`.trim();
  // _scheduledDate from schedule blocks; fall back to job-level date fields
  const scheduledRaw = s(job._scheduledDate)
    || s(job.Scheduled)
    || s(job.DateScheduled)
    || s(job.ScheduledDate)
    || s(job.DateBooked);
  const estRaw       = labHours.Estimate  != null ? Number(labHours.Estimate)  : null;
  const actRaw       = labHours.Actual    != null ? Number(labHours.Actual)    : null;
  const comRaw       = labHours.Committed != null ? Number(labHours.Committed) : null;

  // Use SimPRO's estimate if > 0; otherwise default to 2 per business rule
  const estHours  = estRaw != null && estRaw > 0 ? String(estRaw) : "2";
  const actHours  = actRaw !== null && actRaw > 0
    ? String(actRaw)
    : comRaw !== null && comRaw > 0 ? String(comRaw) : "";

  return [
    s(job.ID),                                                        // Job
    s(status.Name ?? job.Stage),                                      // Status
    fmtDate(s(job.DateIssued)),                                       // Created Date
    custName,                                                         // Customer
    s(site.Name),                                                     // Site
    scheduledRaw ? fmtDate(scheduledRaw) : "",                        // Scheduled
    estHours,                                                         // Est. Hours
    fmtDate(s(job.DueDate)),                                          // Due Date
    techNames(job),                                                   // Technicians
    `$${(Number(total.ExTax ?? 0) || 330).toFixed(2)}`,              // Sell Price
    tagNames(job),                                                    // Tags
    s(address.City),                                                  // Site Suburb
    actHours,                                                         // Actual Hours
    s(job._customerGroup) || s(custGroup.Name) || s(custGroup as unknown as string), // Customer Group
    s(address.PostalCode),                                            // Site Postcode
    s(job.Name),                                                      // Description
    s(job.Notes).replace(/<[^>]*>/g, "").trim(),                     // Notes
  ];
}

export default function BacklogPage() {
  const [company,     setCompany]     = useState<CompanyId>(1);
  const [stage,       setStage]       = useState<Stage>("Pending");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [jobs,        setJobs]        = useState<RawJob[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingSecs, setLoadingSecs] = useState(0);
  const [error,       setError]       = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing,  setRefreshing]  = useState(false);

  const companyLabel = COMPANIES.find((c) => c.id === company)?.label ?? "";

  // Track elapsed seconds while loading so the UI can show a "still working" message
  useEffect(() => {
    if (!loading) { setLoadingSecs(0); return; }
    setLoadingSecs(0);
    const t = setInterval(() => setLoadingSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const fetchJobs = useCallback(async (bg = false, force = false, co = company, st = stage) => {
    if (bg) setRefreshing(true);
    else setLoading(true);
    try {
      const url = `/api/data?company=${co}&stage=${st}${force ? "&force=1" : ""}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setError(`${data.error}${data.detail ? ": " + data.detail : ""}`);
      } else {
        setJobs(Array.isArray(data) ? data : data.Result ?? []);
        setError(null);
        setLastUpdated(new Date());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [company, stage]);

  // Re-fetch when company or stage changes
  useEffect(() => {
    setJobs([]);
    fetchJobs(false, false, company, stage);
    const id = setInterval(() => fetchJobs(true, false, company, stage), POLL_MS);
    return () => clearInterval(id);
  }, [company, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const stageColor = stage === "Pending"
    ? "bg-amber-100 text-amber-700"
    : "bg-blue-100 text-blue-700";

  const headers = company === 8
    ? (stage === "Pending" ? HEADERS_AFAC_PENDING : HEADERS_AFAC_PROGRESS)
    : company === 10
      ? (stage === "Pending" ? HEADERS_ADAIR_PENDING : HEADERS_ADAIR_PROGRESS)
      : HEADERS;
  const getRow = company === 8
    ? (stage === "Pending" ? jobToRowAFACPending : jobToRowAFACProgress)
    : company === 10
      ? (stage === "Pending" ? jobToRowADAIRPending : jobToRowADAIRProgress)
      : jobToRow;

  return (
    <div className="flex flex-col h-screen" onClick={() => setDropdownOpen(false)}>

      {/* Top bar: company dropdown + stage tabs */}
      <div className="flex flex-wrap items-stretch bg-white border-b border-neutral-200 shrink-0">

        {/* Company dropdown */}
        <div className="relative w-full sm:w-auto border-b sm:border-b-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 sm:border-r sm:border-neutral-200 w-full sm:min-w-[180px]"
          >
            <span className="w-3 h-3 rounded-sm bg-red-500 shrink-0" />
            {companyLabel}
            <svg className="ml-auto w-4 h-4 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute top-full left-0 z-50 bg-white border border-neutral-200 rounded-b shadow-lg w-full sm:min-w-[200px]">
              {COMPANIES.map((co) => (
                <button
                  key={co.id}
                  onClick={() => { setCompany(co.id); setDropdownOpen(false); }}
                  className={`w-full text-left flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-neutral-50 ${
                    co.id === company ? "font-semibold text-blue-600" : "text-neutral-700"
                  }`}
                >
                  <span className="w-3 h-3 rounded-sm bg-red-500 shrink-0" />
                  {co.label}
                  {co.id === company && (
                    <svg className="ml-auto w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Dashboard dropdown */}
        <select
          defaultValue="/dashboard"
          onChange={e => { window.location.href = e.target.value; }}
          className="px-5 py-3 text-sm font-medium text-neutral-500 hover:text-neutral-800 border-b sm:border-b-0 sm:border-r border-neutral-200 hover:bg-neutral-50 bg-white cursor-pointer w-full sm:w-auto"
        >
          <option value="/dashboard">Dashboard</option>
          <option value="/dashboard2">Dashboard (NO DATACOM)</option>
        </select>

        {/* Stage tabs */}
        <div className="flex items-center px-2 w-full sm:w-auto">
          {STAGES.map((st) => (
            <button
              key={st}
              onClick={() => setStage(st)}
              className={`flex-1 sm:flex-none px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                st === stage
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-neutral-500 hover:text-neutral-800 hover:border-neutral-300"
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Sub-header: title + controls */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 bg-white border-b border-neutral-200 text-xs text-neutral-500 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-neutral-800 text-sm truncate">
            {companyLabel} — {stage}{company === 8 ? "" : " · A CFSP ONLY"}
          </span>
          {!loading && (
            <span className={`px-2 py-0.5 rounded-full font-semibold text-xs shrink-0 ${stageColor}`}>
              {jobs.length} job{jobs.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {refreshing && <span className="text-blue-500">Refreshing…</span>}
          {lastUpdated && <span className="hidden sm:inline">Updated: {lastUpdated.toLocaleTimeString()}</span>}
          <button
            onClick={() => fetchJobs(false, true)}
            disabled={loading || refreshing}
            className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200 text-neutral-700 disabled:opacity-50"
          >
            Refresh now
          </button>
          <span className="text-neutral-300 hidden sm:inline">Auto every 60s</span>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 text-red-600 text-xs border-b border-red-200 shrink-0">
          Error: {error}
        </div>
      )}
      {loading && (
        <div className="px-4 py-4 text-sm text-neutral-500 shrink-0">
          <span>Loading {stage.toLowerCase()} jobs for {companyLabel}… ({loadingSecs}s)</span>
          {loadingSecs >= 10 && (
            <span className="ml-3 text-amber-600">
              Fetching data from SimPRO — this can take up to 2 minutes on first load.
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse" style={{ minWidth: "1800px" }}>
          <thead className="sticky top-0 z-10">
            <tr style={{ backgroundColor: "#1e293b" }}>
              {headers.map((h, i) => (
                <th key={i} className="text-left text-white font-semibold text-xs uppercase tracking-wide px-3 py-2.5 whitespace-nowrap border-r border-slate-600 last:border-r-0">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && jobs.length === 0 && !error && (
              <tr>
                <td colSpan={headers.length} className="px-3 py-8 text-sm text-neutral-400 text-center">
                  No {stage.toLowerCase()} jobs found for A CFSP ONLY in {companyLabel}.
                </td>
              </tr>
            )}
            {[...jobs].sort((a, b) => {
                const ad = s(a._scheduledDate as string);
                const bd = s(b._scheduledDate as string);
                if (!ad && !bd) return 0;
                if (!ad) return 1;  // unscheduled → end
                if (!bd) return -1;
                return ad.localeCompare(bd); // ascending by date
              }).map((job, row) => {
              const cells = getRow(job);
              return (
                <tr
                  key={s(job.ID) || row}
                  className="border-b border-neutral-200 hover:bg-blue-50 transition-colors"
                  style={{ backgroundColor: row % 2 === 0 ? "#ffffff" : "#f8fafc" }}
                >
                  {cells.map((val, col) => (
                    <td key={col} className="px-3 py-2 text-xs text-neutral-700 border-r border-neutral-100 last:border-r-0 whitespace-nowrap max-w-xs truncate" title={val}>
                      {col === 1 && val ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor(job) }} />
                          {val}
                        </span>
                      ) : (val || " ")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
