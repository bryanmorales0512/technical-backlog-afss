"use client";

import { useEffect, useRef, useState } from "react";
import React from "react";
import Link from "next/link";

type RawJob = Record<string, unknown>;

type LeaveEntry  = { from: string; to: string };
type TeamMember  = { id: number; name: string; role: string; monthlyHours: number; leave: LeaveEntry[] };
type PublicHoliday = { date: string; name: string };
type AfacProspect  = { jobs: number; hours: number; dateFrom: string; dateTo: string; costCentreFiltered: boolean };

const COMPANIES = [
  { id: 1,  label: "RM AFSS" },
  { id: 8,  label: "CHUBB/AFAC AFSS" },
  { id: 10, label: "AE Evac Procedure Audits\n(385 Per Hour)" },
] as const;

const STATUS_ROWS = [
  { key: "scheduled", label: "Scheduled Awaiting to be Done",             bg: "#166534", color: "#fff" },
  { key: "awaiting",  label: "Awaiting Client Info",                       bg: "#2563eb", color: "#fff" },
  { key: "tentative", label: "Tentative Awaiting Scheduling",              bg: "#92400e", color: "#fff" },
  { key: "complete",  label: "Attendance Complete/Results To Be Released",  bg: "#64748b", color: "#fff" },
] as const;

function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function statusKey(job: RawJob): string {
  const stage   = s(job.Stage).toLowerCase();
  const n       = s((job.Status as Record<string, unknown>)?.Name ?? job.Stage).toLowerCase();
  const company = job._company as number | undefined;
  // AE Evac (company 10) Progress = audit booked/scheduled, not attendance complete
  if (stage === "progress" && company === 10) return job._scheduledDate ? "scheduled" : "tentative";
  // All other Progress = attendance already done
  if (stage === "progress" || n.includes("complete") || n.includes("released") || n.includes("attendance")) return "complete";
  if (job._scheduledDate) return "scheduled";
  return "tentative";
}

function jobPrice(job: RawJob): number {
  const p = Number((job.Total as Record<string, unknown>)?.ExTax ?? 0);
  return p > 0 ? p : 330;
}

// CHUBB/AFAC (Company 8): no $330 default — use actual price or $0
function jobPriceAfac(job: RawJob): number {
  return Number((job.Total as Record<string, unknown>)?.ExTax ?? 0);
}

function jobHours(job: RawJob): number {
  const totals   = job.Totals as Record<string, unknown> | undefined;
  const resCost  = totals?.ResourcesCost as Record<string, unknown> | undefined;
  const labHours = resCost?.LaborHours   as Record<string, unknown> | undefined;
  const est      = labHours?.Estimate != null ? Number(labHours.Estimate) : 0;
  return est > 0 ? est : 2;
}

// CHUBB/AFAC (Company 8): booked schedule hours first — SimPRO's Committed can
// be 0 even when a schedule block exists (resource/rate setup), and the manual
// report counts the booked time. Only truly unbooked jobs default to 2.
function jobHoursAfac(job: RawJob): number {
  const sched = Number(job._scheduledHours ?? 0);
  if (sched > 0) return sched;
  const totals    = job.Totals as Record<string, unknown> | undefined;
  const resCost   = totals?.ResourcesCost as Record<string, unknown> | undefined;
  const labHours  = resCost?.LaborHours   as Record<string, unknown> | undefined;
  const committed = labHours?.Committed   != null ? Number(labHours.Committed) : 0;
  return committed > 0 ? committed : 2;
}

// RM AFSS (Company 1): use actual Committed hours whenever the job has any
// booked (even under 2 hrs, e.g. 1.5); only unbooked jobs (Committed = 0)
// default to the 2 hr estimate.
function jobHoursRm(job: RawJob): number {
  const totals    = job.Totals as Record<string, unknown> | undefined;
  const resCost   = totals?.ResourcesCost as Record<string, unknown> | undefined;
  const labHours  = resCost?.LaborHours   as Record<string, unknown> | undefined;
  const committed = labHours?.Committed   != null ? Number(labHours.Committed) : 0;
  return committed > 0 ? committed : 2;
}

function scheduledHrs(job: RawJob): number {
  return Number(job._scheduledHours ?? 0);
}

// Only true if the job appears in a visible status row (excludes complete).
function isInAnyRow(job: RawJob): boolean {
  return statusKey(job) !== "complete";
}

function hrsForJob(job: RawJob): number {
  if (statusKey(job) === "scheduled") {
    const sh = scheduledHrs(job);
    return sh > 0 ? sh : jobHours(job);
  }
  return jobHours(job);
}

interface Stats { count: number; hrs: number; amt: number }

function agg(jobs: RawJob[], getHrs: (j: RawJob) => number = jobHours, getAmt: (j: RawJob) => number = jobPrice): Stats {
  return jobs.reduce<Stats>(
    (a, j) => ({ count: a.count + 1, hrs: a.hrs + getHrs(j), amt: a.amt + getAmt(j) }),
    { count: 0, hrs: 0, amt: 0 }
  );
}

function fmtAmt(n: number) {
  return `$ ${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Office shuts down for the Christmas/New Year break every year, 18 Dec
// through 5 Jan inclusive, regardless of the year — treated as non-working.
function isShutdownDay(d: Date): boolean {
  const month = d.getMonth() + 1, day = d.getDate();
  return (month === 12 && day >= 18) || (month === 1 && day <= 5);
}

function isShutdownDate(dateStr: string): boolean {
  const [, m, d] = dateStr.split("-").map(Number);
  return (m === 12 && d >= 18) || (m === 1 && d <= 5);
}

// Public holidays already covered by the shutdown window (Christmas, Boxing
// Day, New Year's Day) must not also be subtracted separately below, or
// they'd be double-deducted.
function nonShutdownHolidays(hols: PublicHoliday[]): PublicHoliday[] {
  return hols.filter(h => !isShutdownDate(h.date));
}

function totalWorkingDaysInMonth(year: number, month: number): number {
  const lastDay = new Date(year, month, 0);
  let hours = 0;
  for (let d = new Date(year, month - 1, 1); d <= lastDay; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !isShutdownDay(d)) hours += 8;
  }
  return hours;
}

function leaveInMonth(member: TeamMember, now: Date): LeaveEntry[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const monthStart = new Date(y, m, 1);
  const monthEnd   = new Date(y, m + 1, 0);
  return member.leave.filter(l => {
    const from = new Date(l.from);
    const to   = new Date(l.to);
    return from <= monthEnd && to >= monthStart;
  });
}

function isOnLeaveToday(member: TeamMember, now: Date): boolean {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return member.leave.some(l => today >= l.from && today <= l.to);
}

function remainingLeaveDays(member: TeamMember, now: Date): number {
  // Only count leave days from today onwards (remaining in month)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let days = 0;
  for (const l of member.leave) {
    const from = new Date(Math.max(new Date(l.from).getTime(), tomorrow.getTime()));
    const to   = new Date(Math.min(new Date(l.to).getTime(),   monthEnd.getTime()));
    if (from > to) continue;
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) days++;
    }
  }
  return days;
}


function isCurrentMonth(dateStr: string | null | undefined, now: Date): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function currentMonthLabel(now: Date): string {
  return now.toLocaleString("en-AU", { month: "long", year: "numeric" });
}

function StatCells({ s: st, bold, loading }: { s: Stats; bold?: boolean; loading?: boolean }) {
  const cls = `border border-gray-400 px-2 py-3 text-sm ${bold ? "font-bold italic" : ""}`;
  if (loading) {
    return (
      <>
        <td className={`${cls} text-center text-gray-400`}>—</td>
        <td className={`${cls} text-center text-gray-400`}>—</td>
        <td className={`${cls} text-right text-gray-400`}>—</td>
      </>
    );
  }
  return (
    <>
      <td className={`${cls} text-center`}>{st.count}</td>
      <td className={`${cls} text-center`}>{st.hrs.toFixed(2)}</td>
      <td className={`${cls} text-right`}>{fmtAmt(st.amt)}</td>
    </>
  );
}

// Last-known jobs persisted in the browser so the dashboard never renders empty
// (or half-loaded) numbers: stored data paints instantly and each company's
// figures are silently replaced once its complete live response arrives.
const JOBS_LS_KEY = "d1-jobs-v1";

function readStoredJobs(): Record<number, RawJob[]> | null {
  try {
    if (typeof window === "undefined") return null;
    const s = localStorage.getItem(JOBS_LS_KEY);
    const parsed = s ? (JSON.parse(s) as Record<number, RawJob[]>) : null;
    return parsed && Object.keys(parsed).length > 0 ? parsed : null;
  } catch { return null; }
}

function readStoredJobsTs(): Date | null {
  try {
    const t = typeof window !== "undefined" ? localStorage.getItem(`${JOBS_LS_KEY}-ts`) : null;
    return t ? new Date(Number(t)) : null;
  } catch { return null; }
}

export default function DashboardPage() {
  const [byCompany, setByCompany] = useState<Record<number, RawJob[]>>(() => readStoredJobs() ?? {});
  // Latest jobs, readable synchronously inside load() and persisted to localStorage.
  const byCompanyRef = useRef(byCompany);
  const [loading,   setLoading]   = useState(Object.keys(byCompany).length === 0);
  const [hasData,   setHasData]   = useState(Object.keys(byCompany).length > 0);
  const [updated,   setUpdated]   = useState<Date | null>(() => readStoredJobsTs());
  const partialTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now,            setNow]            = useState(() => new Date());
  const [team,           setTeam]           = useState<TeamMember[]>([]);
  const [publicHolidays, setPublicHolidays] = useState<PublicHoliday[]>([]);
  const [monthlyHolidays, setMonthlyHolidays] = useState<Record<string, PublicHoliday[]>>({});
  const [extraTeam,      setExtraTeam]      = useState<TeamMember[]>([]);
  const [hiddenCoreIds,  setHiddenCoreIds]  = useState<Set<number>>(new Set());
  const [addingMember,   setAddingMember]   = useState(false);
  const [searchName,     setSearchName]     = useState("");
  const [searchResults,  setSearchResults]  = useState<{ id: number; name: string; company: number }[]>([]);
  const [selectedStaff,  setSelectedStaff]  = useState<{ id: number; name: string; company: number } | null>(null);
  const [newRole,        setNewRole]        = useState("");
  const [searching,      setSearching]      = useState(false);
  const [saving,         setSaving]         = useState(false);
  const [eodTick,        setEodTick]        = useState(0);
  const [monthFilter,    setMonthFilter]    = useState<string>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search).get("m");
      if (p) return p;
    }
    return "all";
  });
  // Mutable ref always tracks the latest monthFilter so stale-closure callbacks
  // (visibilitychange handler, 90 s timer, 1 h interval) can read the current value,
  // and in-flight fetch callbacks can discard responses for the wrong month.
  const monthFilterRef = useRef<string>(monthFilter);
  const [afacProspect,   setAfacProspect]   = useState<AfacProspect | null>(null);
  const [afacExclusions, setAfacExclusions] = useState<string[]>([]);
  const [afacExcDate,    setAfacExcDate]    = useState("");
  const [afacExcSaving,  setAfacExcSaving]  = useState(false);
  const [afacExcSaved,   setAfacExcSaved]   = useState(false);
  const [icHrs,    setIcHrs]    = useState("");
  const [icRmHrs,  setIcRmHrs]  = useState("");
  const [icAeHrs,  setIcAeHrs]  = useState("");
  const [icFiaHrs, setIcFiaHrs] = useState("");
  const [icSaving, setIcSaving] = useState(false);
  const [icSaved,  setIcSaved]  = useState(false);

  // Technical Support Works — all three sections auto-fetched from API.
  // Initialise from localStorage so last-known values show instantly on refresh.
  const [obData, setObData] = useState<{ jobs: number; hours: number; amount: number } | null>(() => {
    try { const mf = typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("m") ?? "all") : "all"; const s = localStorage.getItem(`d1-ts-ob-${mf}`); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [itData, setItData] = useState<{ jobs: number; hours: number; amount: number } | null>(() => {
    try { const mf = typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("m") ?? "all") : "all"; const s = localStorage.getItem(`d1-ts-it-${mf}`); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [qaData, setQaData] = useState<{ jobs: number; hours: number; amount: number } | null>(() => {
    try { const mf = typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("m") ?? "all") : "all"; const s = localStorage.getItem(`d1-ts-qa-${mf}`); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [techRefreshing, setTechRefreshing] = useState(false);
  const [refreshSecsLeft, setRefreshSecsLeft] = useState(0);
  const [syncing, setSyncing] = useState(false);

  async function load(force = false, silent = false) {
    if (partialTimerRef.current) { clearTimeout(partialTimerRef.current); partialTimerRef.current = null; }
    // Never blank the table when we already have data (stored or live) — sync
    // quietly behind the current numbers and replace them as results land.
    const quiet = silent || Object.keys(byCompanyRef.current).length > 0;
    if (quiet) { setSyncing(true); } else { setLoading(true); }
    let anyFailed = false;
    const sfx = force ? "&force=1" : "";

    await Promise.all(
      COMPANIES.map(async co => {
        // Fetch both stages before painting the company — a lone Pending response
        // would otherwise briefly shrink the company to half its jobs.
        const stages = await Promise.all(
          (["Pending", "Progress"] as const).map(async stage => {
            try {
              const r = await fetch(`/api/data?company=${co.id}&stage=${stage}${sfx}`);
              const d = await r.json();
              if (d?.error) throw new Error(d.error); // error response — retry later
              const jobs: RawJob[] = Array.isArray(d) ? d : (d.Result ?? []);
              return jobs.map((j: RawJob) => ({ ...j, _company: co.id }));
            } catch { return null; }
          })
        );
        if (stages.some(s => s === null)) { anyFailed = true; return; } // keep last-known data for this company
        byCompanyRef.current = { ...byCompanyRef.current, [co.id]: (stages as RawJob[][]).flat() };
        setByCompany(byCompanyRef.current);
        setHasData(true);
        setUpdated(new Date());
      })
    );

    try {
      localStorage.setItem(JOBS_LS_KEY, JSON.stringify(byCompanyRef.current));
      localStorage.setItem(`${JOBS_LS_KEY}-ts`, String(Date.now()));
    } catch {} // quota / private mode — the stored copy is an optimisation only

    if (quiet) { setSyncing(false); } else { setLoading(false); }
    if (!silent && anyFailed) {
      // Some companies failed (e.g. cold cache still warming) — retry after 30 s
      // eslint-disable-next-line react-hooks/exhaustive-deps
      partialTimerRef.current = setTimeout(() => load(), 30_000);
    }
  }

  useEffect(() => {
    load(false).then(() => load(true, true)); // eslint-disable-line react-hooks/exhaustive-deps
    const t = setInterval(() => { load(true, true); loadAfacProspect(true, monthFilterRef.current); loadTechSupport(true, monthFilterRef.current); }, 3_600_000);
    const tRefresh = setTimeout(() => loadTechSupport(false, monthFilterRef.current), 90_000); // eslint-disable-line react-hooks/exhaustive-deps
    return () => { clearInterval(t); clearTimeout(tRefresh); if (partialTimerRef.current) clearTimeout(partialTimerRef.current); };
  }, []); // intentional: load is stable, we only want this to run once

  // Auto-retry if data failed to load (e.g. cold-start API errors) — keeps
  // retrying every 5 s until SimPRO responds with real job data.
  useEffect(() => {
    if (loading || hasData) return;
    const t = setTimeout(() => load(), 30_000); // eslint-disable-line react-hooks/exhaustive-deps
    return () => clearTimeout(t);
  }, [loading, hasData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      const stored = localStorage.getItem("d1-hiddenCoreIds");
      if (stored) setHiddenCoreIds(new Set(JSON.parse(stored) as number[]));
    } catch {}
  }, []);

  function hideCoreTeamMember(id: number) {
    setHiddenCoreIds(prev => {
      const next = new Set(prev).add(id);
      try { localStorage.setItem("d1-hiddenCoreIds", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  function loadLeave(force = false) {
    const sfx = force ? "?force=1" : "";
    fetch(`/api/leave${sfx}`).then(r => r.json()).then(d => {
      if (d.team) {
        setTeam(d.team);
        // Only apply leave API's public holidays when viewing the current month.
        // For other months, loadFilterPublicHolidays sets the correct holidays and
        // we must not let a slow loadLeave response overwrite them with the wrong month's data.
        const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        if (monthFilterRef.current === "all" || monthFilterRef.current === curKey) {
          setPublicHolidays(d.publicHolidays ?? []);
        }
      }
      else setTeam(d); // backward compat
    }).catch(() => {});
  }

  function loadFilterPublicHolidays(mf = monthFilter) {
    const [fy, fm] = mf === "all"
      ? [now.getFullYear(), now.getMonth() + 1]
      : mf.split("-").map(Number);
    fetch(`/api/public-holidays?year=${fy}&month=${fm}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setPublicHolidays(d); })
      .catch(() => {});
  }

  function loadExtraTeam() {
    fetch("/api/extra-team").then(r => r.json()).then(setExtraTeam).catch(() => {});
  }

  function loadIntercompany() {
    fetch("/api/intercompany")
      .then(r => r.json())
      .then(d => {
        if (d.hrs    != null) setIcHrs(d.hrs);
        if (d.rmHrs  != null) setIcRmHrs(d.rmHrs);
        if (d.aeHrs  != null) setIcAeHrs(d.aeHrs);
        if (d.fiaHrs != null) setIcFiaHrs(d.fiaHrs);
      })
      .catch(() => {});
  }

  async function saveIntercompany() {
    setIcSaving(true);
    try {
      await fetch("/api/intercompany", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hrs: icHrs, rmHrs: icRmHrs, aeHrs: icAeHrs, fiaHrs: icFiaHrs }),
      });
      setIcSaved(true);
      setTimeout(() => setIcSaved(false), 2000);
    } catch { /* ignore */ }
    setIcSaving(false);
  }

  async function searchSimPRO() {
    if (!searchName.trim()) return;
    setSearching(true);
    setSearchResults([]);
    setSelectedStaff(null);
    try {
      const r = await fetch(`/api/extra-team/search?name=${encodeURIComponent(searchName)}`);
      const data = await r.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
    setSearching(false);
  }

  async function saveExtraMember() {
    if (!selectedStaff) return;
    setSaving(true);
    try {
      await fetch("/api/extra-team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selectedStaff, role: newRole }),
      });
      setAddingMember(false);
      setSearchName("");
      setSearchResults([]);
      setSelectedStaff(null);
      setNewRole("");
      loadExtraTeam();
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function removeExtraMember(id: number) {
    await fetch("/api/extra-team", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadExtraTeam();
  }

  function loadAfacExclusions() {
    fetch("/api/afac-exclusions")
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setAfacExclusions(d); })
      .catch(() => {});
  }

  async function saveAfacExclusions(dates: string[]) {
    setAfacExcSaving(true);
    try {
      await fetch("/api/afac-exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dates),
      });
      setAfacExclusions(dates);
      setAfacExcSaved(true);
      setTimeout(() => setAfacExcSaved(false), 2000);
      loadAfacProspect(true, monthFilter);
    } catch { /* ignore */ }
    setAfacExcSaving(false);
  }

  function loadAfacProspect(force = false, mf = monthFilter) {
    const p = new URLSearchParams();
    if (force) p.set("force", "1");
    if (mf !== "all") {
      const [y, m] = mf.split("-");
      p.set("year", y);
      p.set("month", m);
    }
    fetch(`/api/afac-prospect?${p}`)
      .then(r => r.json())
      .then(d => { if (monthFilterRef.current !== mf) return; if (d?.jobs != null) setAfacProspect(d); })
      .catch(() => {});
  }

  function loadTechSupport(force = false, mf = monthFilter) {
    const p = new URLSearchParams();
    if (force) p.set("force", "1");
    if (mf === "all") {
      p.set("all", "1");
    } else {
      const [y, m] = mf.split("-");
      p.set("year", y);
      p.set("month", m);
    }
    if (force) setTechRefreshing(true);
    fetch(`/api/tech-support?${p}`)
      .then(r => r.json())
      .then(d => {
        if (monthFilterRef.current !== mf) return; // discard stale response
        if (d?.otherBillable    != null) { setObData(d.otherBillable);    try { localStorage.setItem(`d1-ts-ob-${mf}`, JSON.stringify(d.otherBillable));    } catch {} }
        if (d?.investedTime     != null) { setItData(d.investedTime);     try { localStorage.setItem(`d1-ts-it-${mf}`, JSON.stringify(d.investedTime));     } catch {} }
        if (d?.qualityAssurance != null) { setQaData(d.qualityAssurance); try { localStorage.setItem(`d1-ts-qa-${mf}`, JSON.stringify(d.qualityAssurance)); } catch {} }
      })
      .catch(() => {})
      .finally(() => { if (force) setTechRefreshing(false); });
  }

  useEffect(() => {
    loadLeave(); // eslint-disable-line react-hooks/exhaustive-deps
    loadAfacProspect(); // eslint-disable-line react-hooks/exhaustive-deps
    loadExtraTeam(); // eslint-disable-line react-hooks/exhaustive-deps
    loadIntercompany(); // eslint-disable-line react-hooks/exhaustive-deps
    loadAfacExclusions(); // eslint-disable-line react-hooks/exhaustive-deps

    // Always fetch live from SimPRO on page load so the dashboard never shows stale data.
    loadTechSupport(true); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-fetch shared data when this tab becomes visible so changes made in
    // the other dashboard are reflected immediately without a manual refresh.
    function onVisible() {
      if (document.visibilityState === "visible") {
        loadIntercompany(); // eslint-disable-line react-hooks/exhaustive-deps
        loadAfacExclusions(); // eslint-disable-line react-hooks/exhaustive-deps
        loadAfacProspect(false, monthFilterRef.current); // eslint-disable-line react-hooks/exhaustive-deps
        loadTechSupport(true, monthFilterRef.current); // eslint-disable-line react-hooks/exhaustive-deps
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []); // intentional: stable refs, run once

  // Fire exactly at midnight so the month label flips in real time
  useEffect(() => {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms = midnight.getTime() - Date.now();
    const t = setTimeout(() => setNow(new Date()), ms);
    return () => clearTimeout(t);
  }, [now]);

  // Fire at 3 PM every day — deducts today's hours from remaining supply
  useEffect(() => {
    const n    = new Date();
    const next = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 15, 0, 0, 0);
    if (n >= next) next.setDate(next.getDate() + 1); // already past 3 PM, aim for tomorrow
    const ms = next.getTime() - Date.now();
    const t  = setTimeout(() => setEodTick(v => v + 1), ms);
    return () => clearTimeout(t);
  }, [eodTick]); // re-chains after each fire

  useEffect(() => {
    if (eodTick > 0) loadLeave(true); // eslint-disable-line react-hooks/exhaustive-deps
  }, [eodTick]);

  // Sync month filter to URL so it survives hard reloads; keep ref current so
  // stale callbacks can always see the latest selected month.
  useEffect(() => {
    monthFilterRef.current = monthFilter;
    const url = new URL(window.location.href);
    if (monthFilter === "all") url.searchParams.delete("m");
    else url.searchParams.set("m", monthFilter);
    window.history.replaceState(null, "", url.toString());
  }, [monthFilter]);

  // Re-fetch tech support and AFAC prospect whenever month changes.
  // Restore last-known values immediately so dashes never flash on screen.
  useEffect(() => {
    try {
      const ob = localStorage.getItem(`d1-ts-ob-${monthFilter}`);
      const it = localStorage.getItem(`d1-ts-it-${monthFilter}`);
      const qa = localStorage.getItem(`d1-ts-qa-${monthFilter}`);
      setObData(ob ? JSON.parse(ob) : null);
      setItData(it ? JSON.parse(it) : null);
      setQaData(qa ? JSON.parse(qa) : null);
    } catch { setObData(null); setItData(null); setQaData(null); }
    setAfacProspect(null);
    loadTechSupport(true, monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
    loadFilterPublicHolidays(monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
    loadAfacProspect(false, monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
  }, [monthFilter]);

  // Fetch public holidays for every month from now through the selected
  // month (not just the selected one) so Technical Team Supply can show a
  // column per month when a future month is selected.
  useEffect(() => {
    if (monthFilter === "all") return;
    const [fy, fm] = monthFilter.split("-").map(Number);
    const months: { year: number; month: number }[] = [];
    let y = now.getFullYear(), m = now.getMonth() + 1;
    while (y < fy || (y === fy && m <= fm)) {
      months.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
    }
    let cancelled = false;
    Promise.all(months.map(async ({ year, month }): Promise<[string, PublicHoliday[]]> => {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      try {
        const r = await fetch(`/api/public-holidays?year=${year}&month=${month}`);
        const d = await r.json();
        return [key, Array.isArray(d) ? d : []];
      } catch { return [key, []]; }
    })).then(results => {
      if (cancelled) return;
      setMonthlyHolidays(prev => {
        const next = { ...prev };
        for (const [k, v] of results) next[k] = v;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [monthFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cold-start recovery: if tech-support data is still null 15 s after mount
  // (server was still building the cache when the first request arrived),
  // keep retrying every 15 s until it loads.
  useEffect(() => {
    if (obData != null || itData != null || qaData != null) return;
    const t = setTimeout(() => loadTechSupport(false, monthFilter), 15_000); // eslint-disable-line react-hooks/exhaustive-deps
    return () => clearTimeout(t);
  }, [obData, itData, qaData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown timer for Refresh now button
  useEffect(() => {
    if (!techRefreshing) { setRefreshSecsLeft(0); return; }
    setRefreshSecsLeft(90);
    const t = setInterval(() => setRefreshSecsLeft(s => Math.max(0, s - 1)), 1000);
    const safety = setTimeout(() => setTechRefreshing(false), 150_000);
    return () => { clearInterval(t); clearTimeout(safety); };
  }, [techRefreshing]);

  // Exclude jobs with "A BLOCK PLANS" technician from dashboard counts
  const isBlockPlansJob = (job: RawJob) =>
    ((job.Technicians as Record<string, unknown>[]) ?? [])
      .some(t => String((t as Record<string, unknown>).Name ?? "").toUpperCase().includes("BLOCK PLANS"));

  const allJobs = Object.values(byCompany).flat().filter(j => !isBlockPlansJob(j));
  const coJobs  = (id: number) => (byCompany[id] ?? []).filter(j => !isBlockPlansJob(j));
  const filterJobs = (jobs: RawJob[]) => {
    if (monthFilter === "all") {
      // AE Evac (company 10): the backlog view only counts audits booked from
      // the start of the current month to the end of the month after next
      // (e.g. Jul-Sep) — SimPRO carries next year's evac program with 2027
      // schedule dates. Unscheduled (tentative) jobs stay visible.
      const winStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const winEndD  = new Date(now.getFullYear(), now.getMonth() + 3, 0);
      const winEnd   = `${winEndD.getFullYear()}-${String(winEndD.getMonth() + 1).padStart(2, "0")}-${String(winEndD.getDate()).padStart(2, "0")}`;
      return jobs.filter(j => {
        if ((j._company as number) !== 10) return true;
        const sched = j._scheduledDate as string | null;
        if (!sched) return true;
        return sched >= winStart && sched <= winEnd;
      });
    }
    const [fy, fm] = monthFilter.split("-").map(Number);
    const isFutureMonth = fy > now.getFullYear() || (fy === now.getFullYear() && fm > now.getMonth() + 1);
    const isPastMonth   = fy < now.getFullYear() || (fy === now.getFullYear() && fm < now.getMonth() + 1);
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const monthEndStr = `${fy}-${String(fm).padStart(2, "0")}-${String(new Date(fy, fm, 0).getDate()).padStart(2, "0")}`;
    return jobs.filter(j => {
      const due = j.DueDate as string | null;
      if (due && new Date(due).getFullYear() > fy) return false;

      const sched = j._scheduledDate as string | null;
      if (sched) {
        // Every company: scheduled jobs use today -> end of month for the
        // current/future month, so already-past scheduled days don't
        // inflate this month's Sum of Est. Hrs. Past months still show
        // their whole month (there's no "today" to window from).
        if (!isPastMonth) return sched >= todayStr && sched <= monthEndStr;
        const dt = new Date(sched);
        return dt.getFullYear() === fy && dt.getMonth() + 1 === fm;
      }
      // Tentative jobs (no scheduled date):
      // No DueDate at all: always include, any company — nothing to judge it against.
      // CHUBB (company 8): always include all pending jobs regardless of DueDate.
      // RM AFSS (company 1): same bounded window as scheduled jobs above —
      // DueDate must fall between today and end of month for the
      // current/future month; past months show the whole month.
      // Others: include if DueDate >= today.
      if (!due) return true;
      if ((j._company as number) === 8) return true;
      if ((j._company as number) === 1) {
        if (!isPastMonth) return due >= todayStr && due <= monthEndStr;
        const dt = new Date(due);
        return dt.getFullYear() === fy && dt.getMonth() + 1 === fm;
      }
      if (isFutureMonth) return due >= todayStr;
      const dt = new Date(due);
      return dt.getFullYear() === fy && dt.getMonth() + 1 === fm;
    });
  };
  const visibleAll  = filterJobs(allJobs);
  const visibleCo   = (id: number) => filterJobs(coJobs(id));

  // Fixed range (current month through December) rather than deriving from
  // job dates — a month with no jobs yet should still be selectable, not
  // silently missing from the dropdown.
  const monthRange: string[] = [];
  for (let m = now.getMonth() + 1; m <= 12; m++) {
    monthRange.push(`${now.getFullYear()}-${String(m).padStart(2, "0")}`);
  }
  const monthOptions = [
    { value: "all", label: "All" },
    ...monthRange.map(val => {
      const [y, m] = val.split("-").map(Number);
      const d = new Date(y, m - 1, 1);
      return { value: val, label: d.toLocaleString("en-AU", { month: "long", year: "numeric" }) };
    }),
  ];

  const supplyMonthDate = monthFilter === "all"
    ? now
    : (() => { const [fy, fm] = monthFilter.split("-").map(Number); return new Date(fy, fm - 1, 1); })();
  const isFutureMonthFilter = monthFilter !== "all" && (() => {
    const [fy, fm] = monthFilter.split("-").map(Number);
    return fy > now.getFullYear() || (fy === now.getFullYear() && fm > now.getMonth() + 1);
  })();
  const getMonthHours = (member: TeamMember): number => {
    if (monthFilter === "all") return member.monthlyHours;
    const [fy, fm] = monthFilter.split("-").map(Number);
    if (fy === now.getFullYear() && fm === now.getMonth() + 1) return member.monthlyHours;
    const isFuture = fy > now.getFullYear() || (fy === now.getFullYear() && fm > now.getMonth() + 1);
    if (isFuture) return totalWorkingDaysInMonth(fy, fm) - nonShutdownHolidays(publicHolidays).length * 8;
    return totalWorkingDaysInMonth(fy, fm) - nonShutdownHolidays(publicHolidays).length * 8;
  };

  // Every month from now through the selected month (inclusive) — drives
  // Technical Team Supply showing one column per month instead of just two.
  // A past-month selection just shows that single month, same as before.
  const supplyMonths: { year: number; month: number }[] = (() => {
    const endY = supplyMonthDate.getFullYear(), endM = supplyMonthDate.getMonth() + 1;
    const isPast = endY < now.getFullYear() || (endY === now.getFullYear() && endM < now.getMonth() + 1);
    if (isPast) return [{ year: endY, month: endM }];
    const months: { year: number; month: number }[] = [];
    let y = now.getFullYear(), m = now.getMonth() + 1;
    while (y < endY || (y === endY && m <= endM)) {
      months.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
    }
    return months;
  })();
  const holidaysFor = (year: number, month: number): PublicHoliday[] =>
    monthlyHolidays[`${year}-${String(month).padStart(2, "0")}`] ?? [];
  const monthSupplyHours = (member: TeamMember, year: number, month: number): number => {
    if (year === now.getFullYear() && month === now.getMonth() + 1) return member.monthlyHours;
    return totalWorkingDaysInMonth(year, month) - nonShutdownHolidays(holidaysFor(year, month)).length * 8;
  };

  const TH = ({ children }: { children: React.ReactNode }) => (
    <th className="border border-gray-400 px-2 py-3 text-center text-xs font-semibold bg-blue-500 text-white">
      {children}
    </th>
  );

  return (
    <div className="flex flex-col bg-white">
      {/* Nav */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 bg-white border-b border-neutral-200 shrink-0">
        <Link href="/" className="text-sm text-blue-600 hover:underline font-medium shrink-0">← Backlog</Link>
        <select
          defaultValue="/dashboard"
          onChange={e => { window.location.href = e.target.value; }}
          className="shrink-0 font-bold text-sm text-neutral-800 border border-neutral-300 rounded px-2 py-0.5 bg-white cursor-pointer"
        >
          <option value="/dashboard">Dashboard</option>
          <option value="/dashboard2">Dashboard (NO DATACOM)</option>
        </select>
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden">
          {loading && !hasData && <span className="text-xs text-blue-500 animate-pulse shrink-0">Loading…</span>}
          {updated && !loading && (
            <span className="text-xs text-neutral-400 shrink-0">Updated: {updated.toLocaleTimeString()}</span>
          )}
          {syncing && !loading && <span className="text-xs text-blue-400 animate-pulse shrink-0">Syncing…</span>}
          <span className="text-xs text-neutral-400 truncate">
            {hasData && `${visibleAll.length} total jobs${monthFilter !== "all" ? ` in ${monthOptions.find(o => o.value === monthFilter)?.label ?? ""}` : " across all companies"}`}
          </span>
        </span>
        <select
          value={monthFilter}
          onChange={e => setMonthFilter(e.target.value)}
          className="shrink-0 px-2 py-1 rounded border border-neutral-300 text-xs bg-white text-neutral-800 font-semibold cursor-pointer"
        >
          {monthOptions.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="p-4 w-full overflow-x-auto">
        <table className="border-collapse w-full table-fixed" style={{ minWidth: '860px' }}>
          <thead>
            {/* Row 1 */}
            <tr>
              <td
                rowSpan={3}
                className="border border-gray-400 p-4 text-center align-middle font-bold text-xl"
                style={{ backgroundColor: "#1e293b", color: "#fff", width: "14%" }}
              >
                TECH TEAM WORKS
              </td>
              <td
                colSpan={3}
                rowSpan={2}
                className="border border-gray-400 px-3 py-4 text-center text-sm font-medium"
                style={{ backgroundColor: "#1e293b", color: "#fff", width: "21%" }}
              >
                Work Demand (Total)
              </td>
              <td colSpan={9} className="border border-gray-400 px-3 py-3 text-center font-bold text-base bg-slate-800 text-white">
                AFSS AUDITS
              </td>
            </tr>
            {/* Row 2 */}
            <tr>
              {COMPANIES.map((co, i) => (
                <td
                  key={co.id}
                  colSpan={3}
                  className="border border-gray-400 px-2 py-3 text-center text-sm font-semibold whitespace-pre-line"
                  style={{ backgroundColor: "#1e293b", color: "#fff", width: "21%" }}
                >
                  {co.label}
                </td>
              ))}
            </tr>
            {/* Row 3 */}
            <tr>
              <TH>Count of Job</TH>
              <TH>Sum of Est. Hours</TH>
              <TH>Sum of Amounts</TH>
              {COMPANIES.map(co => (
                <React.Fragment key={co.id}>
                  <TH># of Jobs</TH><TH>Sum of Est. Hrs</TH><TH>Invoice Amount</TH>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !hasData ? (
              <tr>
                <td
                  colSpan={13}
                  className="border border-gray-400 px-4 py-8 text-center text-sm text-blue-500 animate-pulse"
                >
                  Loading data from SimPRO…
                </td>
              </tr>
            ) : (
              <>
                {/* Total Backlog */}
                <tr>
                  <td
                    className="border border-gray-400 px-3 py-3 text-sm font-bold italic"
                    style={{ backgroundColor: "#f1f5f9" }}
                  >
                    Total Backlog as at end of period
                  </td>
                  <StatCells s={(() => { const icSum = (parseFloat(icRmHrs)||0)+(parseFloat(icAeHrs)||0)+(parseFloat(icFiaHrs)||0); const b = COMPANIES.reduce((acc, co) => { const s = agg(visibleCo(co.id).filter(isInAnyRow), co.id === 8 ? jobHoursAfac : co.id === 1 ? jobHoursRm : hrsForJob, co.id === 8 ? jobPriceAfac : jobPrice); return { count: acc.count + s.count, hrs: acc.hrs + s.hrs, amt: acc.amt + s.amt }; }, { count: 0, hrs: 0, amt: 0 }); return { count: b.count + (obData?.jobs ?? 0) + (itData?.jobs ?? 0) + (qaData?.jobs ?? 0) + (afacProspect?.jobs ?? 0), hrs: b.hrs + (afacProspect?.hours ?? 0) + (obData?.hours ?? 0) + (itData?.hours ?? 0) + (qaData?.hours ?? 0) + icSum, amt: b.amt + (obData?.amount ?? 0) + (itData?.amount ?? 0) + (qaData?.amount ?? 0) + ((afacProspect?.hours ?? 0) * 100) + (icSum * 100) }; })()} bold />
                  {COMPANIES.map(co => <StatCells key={co.id} s={agg(visibleCo(co.id).filter(isInAnyRow), co.id === 8 ? jobHoursAfac : co.id === 1 ? jobHoursRm : hrsForJob, co.id === 8 ? jobPriceAfac : jobPrice)} bold loading={!(co.id in byCompany)} />)}
                </tr>

                {/* All Companies label */}
                <tr>
                  <td
                    colSpan={13}
                    className="border border-gray-400 px-2 py-1 text-center text-sm italic text-gray-500"
                    style={{ backgroundColor: "#f1f5f9" }}
                  >
                    {monthFilter !== "all" ? (monthOptions.find(o => o.value === monthFilter)?.label ?? "All Companies") : "All Companies"}
                  </td>
                </tr>

                {/* Status rows */}
                {STATUS_ROWS.map(row => {
                  const getHrs = row.key === "scheduled"
                    ? (j: RawJob) => { const sh = scheduledHrs(j); return sh > 0 ? sh : jobHours(j); }
                    : jobHours;
                  const rowFilter = (j: RawJob) => statusKey(j) === row.key;
                  const zero = { count: 0, hrs: 0, amt: 0 };
                  return (
                    <React.Fragment key={row.key}>
                      <tr>
                        <td
                          className="border border-gray-400 px-2 py-3 text-center text-sm font-semibold"
                          style={{ backgroundColor: row.bg, color: row.color }}
                        >
                          {row.label}
                        </td>
                        <StatCells s={(() => { if (row.key === "complete") return zero; const base = COMPANIES.reduce((acc, co) => { const coGetHrs = co.id === 8 ? jobHoursAfac : co.id === 1 ? jobHoursRm : getHrs; const s = agg(visibleCo(co.id).filter(rowFilter), coGetHrs, co.id === 8 ? jobPriceAfac : jobPrice); return { count: acc.count + s.count, hrs: acc.hrs + s.hrs, amt: acc.amt + s.amt }; }, { count: 0, hrs: 0, amt: 0 }); if (row.key === "scheduled") return { count: base.count + (obData?.jobs ?? 0) + (itData?.jobs ?? 0), hrs: base.hrs + (obData?.hours ?? 0) + (itData?.hours ?? 0), amt: base.amt + (obData?.amount ?? 0) + (itData?.amount ?? 0) }; if (row.key === "tentative") return { count: base.count + (qaData?.jobs ?? 0) + (afacProspect?.jobs ?? 0), hrs: base.hrs + (qaData?.hours ?? 0) + (afacProspect?.hours ?? 0), amt: base.amt + (qaData?.amount ?? 0) + ((afacProspect?.hours ?? 0) * 100) }; return base; })()} />
                        {COMPANIES.map(co => {
                          const jobs = visibleCo(co.id).filter(rowFilter);
                          const coGetHrs = co.id === 8 ? jobHoursAfac : co.id === 1 ? jobHoursRm : getHrs;
                          const s = agg(jobs, coGetHrs, co.id === 8 ? jobPriceAfac : jobPrice);
                          return <StatCells key={co.id} s={row.key === "complete" ? zero : s} loading={!(co.id in byCompany)} />;
                        })}
                      </tr>
                    </React.Fragment>
                  );
                })}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom section: Technical Team Supply + Technical Support Works side by side */}
      <div className="px-4 pb-6 flex flex-col xl:flex-row gap-6 items-start">

          {/* Technical Team Supply */}
          <div className="w-full xl:w-auto xl:shrink-0">
            {team.length > 0 ? (<>
            <table className="border-collapse text-sm w-full" style={{ maxWidth: 140 + supplyMonths.length * 52 + 92 + 170 + 24 }}>
              <thead>
                <tr>
                  <td rowSpan={2} className="border border-gray-400 px-3 py-3 font-bold text-base text-center align-middle" style={{ backgroundColor: "#1e293b", color: "#fff", width: 140 }}>
                    Technical Team Supply
                  </td>
                  <td colSpan={supplyMonths.length + 2} className="border border-gray-400 px-3 py-1 text-center font-semibold text-xs" style={{ backgroundColor: "#475569", color: "#fff" }}>
                    END OF PERIOD GENERATED
                  </td>
                </tr>
                <tr>
                  <td colSpan={supplyMonths.length + 2} className="border border-gray-400 px-3 py-2 text-center font-bold text-base" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                    {supplyMonths.length > 1
                      ? `${new Date(supplyMonths[0].year, supplyMonths[0].month - 1, 1).toLocaleString("en-AU", { month: "long" })} – ${new Date(supplyMonths[supplyMonths.length - 1].year, supplyMonths[supplyMonths.length - 1].month - 1, 1).toLocaleString("en-AU", { month: "long" })}`
                      : supplyMonthDate.toLocaleString("en-AU", { month: "long" })}
                  </td>
                </tr>
                <tr>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}>APFS / AUDITOR</th>
                  {supplyMonths.map(({ year, month }) => (
                    <th key={`${year}-${month}`} className="border border-gray-400 px-1.5 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9", width: 52 }}>
                      {new Date(year, month - 1, 1).toLocaleString("en-AU", { month: "short" })}
                    </th>
                  ))}
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9", width: 92 }}>Total Supply Hours</th>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9", width: 170 }}>Roles</th>
                </tr>
              </thead>
              <tbody>
                {team.filter(m => !hiddenCoreIds.has(m.id)).map(member => {
                  const onLeaveNow = isOnLeaveToday(member, now);
                  const monthVals = supplyMonths.map(({ year, month }) => {
                    const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                    if (isCurrent) return member.monthlyHours;
                    const leaveDays = remainingLeaveDays(member, new Date(year, month - 1, 1));
                    return Math.max(0, monthSupplyHours(member, year, month) - leaveDays * 8);
                  });
                  return (
                    <tr key={member.id}>
                      <td className="border border-gray-400 px-3 py-2 text-center text-sm">
                        <span className="flex items-center justify-center gap-1">
                          {member.name}
                          {onLeaveNow && <span className="text-xs text-red-500 font-semibold">(On Leave)</span>}
                          <button
                            onClick={() => hideCoreTeamMember(member.id)}
                            className="ml-1 text-red-400 hover:text-red-600 text-xs font-bold leading-none"
                            title="Remove member"
                          >×</button>
                        </span>
                      </td>
                      {monthVals.map((v, i) => (
                        <td key={i} className="border border-gray-400 px-1.5 py-2 text-center text-sm">{v}</td>
                      ))}
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{monthVals.reduce((s, v) => s + v, 0)}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-xs">{member.role}</td>
                    </tr>
                  );
                })}

                {/* Extra (manager-added) team members */}
                {extraTeam.map(member => {
                  const onLeaveNow = isOnLeaveToday(member, now);
                  const monthVals = supplyMonths.map(({ year, month }) => {
                    const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                    if (isCurrent) return member.monthlyHours;
                    const leaveDays = remainingLeaveDays(member, new Date(year, month - 1, 1));
                    return Math.max(0, monthSupplyHours(member, year, month) - leaveDays * 8);
                  });
                  return (
                    <tr key={member.id} style={{ backgroundColor: "#eef2f6" }}>
                      <td className="border border-gray-400 px-3 py-2 text-center text-sm">
                        <span className="flex items-center justify-center gap-1">
                          {member.name}
                          {onLeaveNow && <span className="text-xs text-red-500 font-semibold">(On Leave)</span>}
                          <button
                            onClick={() => removeExtraMember(member.id)}
                            className="ml-1 text-red-400 hover:text-red-600 text-xs font-bold leading-none"
                            title="Remove member"
                          >×</button>
                        </span>
                      </td>
                      {monthVals.map((v, i) => (
                        <td key={i} className="border border-gray-400 px-1.5 py-2 text-center text-sm">{v}</td>
                      ))}
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{monthVals.reduce((s, v) => s + v, 0)}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-xs">{member.role}</td>
                    </tr>
                  );
                })}

                {/* Public Holidays row — current month is blank here since its
                    deduction is already baked into member.monthlyHours server-side */}
                {supplyMonths.some(({ year, month }) => !(year === now.getFullYear() && month === now.getMonth() + 1) && holidaysFor(year, month).length > 0) && (
                  <tr>
                    <td className="border border-gray-400 px-3 py-1 text-center text-xs font-semibold text-red-600">Public Holidays</td>
                    {supplyMonths.map(({ year, month }) => {
                      const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                      const h = isCurrent ? [] : holidaysFor(year, month);
                      return (
                        <td key={`${year}-${month}`} className="border border-gray-400 px-1.5 py-1 text-center text-xs text-red-600">
                          {h.length > 0 ? `−${h.length * 8}` : ""}
                        </td>
                      );
                    })}
                    <td className="border border-gray-400 px-2 py-1 text-center text-xs text-red-600">
                      −{supplyMonths.reduce((s, { year, month }) => {
                        const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                        return s + (isCurrent ? 0 : holidaysFor(year, month).length * 8);
                      }, 0)}
                    </td>
                    <td className="border border-gray-400 px-2 py-1 text-xs text-red-600">
                      {supplyMonths.flatMap(({ year, month }) => {
                        const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                        return isCurrent ? [] : holidaysFor(year, month).map(ph => {
                          const d = ph.date.split("-")[2];
                          return `${ph.name} (${parseInt(d)} ${new Date(year, month - 1, 1).toLocaleString("en-AU", { month: "short" })})`;
                        });
                      }).join(" · ")}
                    </td>
                  </tr>
                )}

                {/* Total row (includes extra members) */}
                <tr className="font-bold">
                  <td className="border border-gray-400 px-3 py-2" style={{ backgroundColor: "#f1f5f9" }} />
                  {supplyMonths.map(({ year, month }) => {
                    const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                    const colTotal = [...team.filter(m => !hiddenCoreIds.has(m.id)), ...extraTeam].reduce((s, m) => {
                      if (isCurrent) return s + m.monthlyHours;
                      const leaveDays = remainingLeaveDays(m, new Date(year, month - 1, 1));
                      return s + Math.max(0, monthSupplyHours(m, year, month) - leaveDays * 8);
                    }, 0);
                    return (
                      <td key={`${year}-${month}`} className="border border-gray-400 px-1.5 py-2 text-center" style={{ backgroundColor: "#f1f5f9" }}>
                        {colTotal}
                      </td>
                    );
                  })}
                  <td className="border border-gray-400 px-2 py-2 text-center" style={{ backgroundColor: "#f1f5f9" }}>
                    {supplyMonths.reduce((total, { year, month }) => {
                      const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;
                      return total + [...team.filter(m => !hiddenCoreIds.has(m.id)), ...extraTeam].reduce((s, m) => {
                        if (isCurrent) return s + m.monthlyHours;
                        const leaveDays = remainingLeaveDays(m, new Date(year, month - 1, 1));
                        return s + Math.max(0, monthSupplyHours(m, year, month) - leaveDays * 8);
                      }, 0);
                    }, 0)}
                  </td>
                  <td className="border border-gray-400 px-2 py-2" style={{ backgroundColor: "#f1f5f9" }} />
                </tr>

                {/* Add Member UI */}
                {!addingMember ? (
                  <tr>
                    <td colSpan={isFutureMonthFilter ? 5 : 4} className="border border-gray-400 px-2 py-1 text-center">
                      <button
                        onClick={() => setAddingMember(true)}
                        className="text-xs text-blue-600 hover:text-blue-800 font-semibold"
                      >
                        + Add Member
                      </button>
                    </td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td colSpan={isFutureMonthFilter ? 5 : 4} className="border border-gray-400 px-3 py-2" style={{ backgroundColor: "#f8fafc" }}>
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              placeholder="Search name in SimPRO…"
                              value={searchName}
                              onChange={e => setSearchName(e.target.value)}
                              onKeyDown={e => e.key === "Enter" && searchSimPRO()}
                              className="border border-gray-300 rounded px-2 py-1 text-xs flex-1"
                            />
                            <button
                              onClick={searchSimPRO}
                              disabled={searching}
                              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            >
                              {searching ? "Searching…" : "Search"}
                            </button>
                            <button
                              onClick={() => { setAddingMember(false); setSearchName(""); setSearchResults([]); setSelectedStaff(null); setNewRole(""); }}
                              className="px-3 py-1 text-xs bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
                            >
                              Cancel
                            </button>
                          </div>

                          {searchResults.length > 0 && (
                            <div className="flex flex-col gap-1">
                              <div className="text-xs text-gray-500 font-semibold">Select person:</div>
                              {searchResults.map(r => (
                                <label key={r.id} className="flex items-center gap-2 text-xs cursor-pointer">
                                  <input
                                    type="radio"
                                    name="staffSelect"
                                    checked={selectedStaff?.id === r.id}
                                    onChange={() => setSelectedStaff(r)}
                                  />
                                  {r.name} <span className="text-gray-400">(Company {r.company})</span>
                                </label>
                              ))}
                            </div>
                          )}

                          {searchResults.length === 0 && !searching && searchName && (
                            <div className="text-xs text-gray-400">No results — try a partial name</div>
                          )}

                          {selectedStaff && (
                            <div className="flex gap-2 items-center mt-1">
                              <input
                                type="text"
                                placeholder="Role (e.g. Primary APFS)"
                                value={newRole}
                                onChange={e => setNewRole(e.target.value)}
                                className="border border-gray-300 rounded px-2 py-1 text-xs flex-1"
                              />
                              <button
                                onClick={saveExtraMember}
                                disabled={saving}
                                className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                              >
                                {saving ? "Saving…" : "Save"}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
            {team.some(m => leaveInMonth(m, supplyMonthDate).length > 0) && (
              <div className="mt-2 text-xs text-gray-600">
                <span className="font-semibold">*Note: </span>
                {team.flatMap(m =>
                  leaveInMonth(m, supplyMonthDate).map(l => {
                    const fmt = (d: string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
                    const range = l.from === l.to ? fmt(l.from) : `${fmt(l.from)} to ${fmt(l.to)}`;
                    return `${m.name.split(" ")[0]} on Leave ${range}`;
                  })
                ).join("  •  ")}
              </div>
            )}
            {/* Intercompany Work */}
            <div className="mt-4">
              <div className="flex items-center justify-center gap-3 mb-2">
                <div className="font-bold text-base">INTERCOMPANY WORK</div>
                <button
                  onClick={saveIntercompany}
                  disabled={icSaving}
                  className="px-3 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {icSaving ? "Saving…" : icSaved ? "Saved ✓" : "Save"}
                </button>
              </div>
              <div className="border border-gray-400 px-3 py-2 mb-2 text-xs text-center italic text-slate-600" style={{ backgroundColor: "#f1f5f9" }}>
                this is time assigned to RM or Adair for them to schedule tech team resources at their pleasure ($100 hour)
              </div>
              <table className="border-collapse text-sm w-full">
                <thead>
                  <tr>
                    <th className="border border-gray-400 px-3 py-2 text-xs font-semibold bg-white"></th>
                    <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold bg-white">Sum of Est. Hrs</th>
                    <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold bg-white">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const t = (parseFloat(icRmHrs)||0) + (parseFloat(icAeHrs)||0) + (parseFloat(icFiaHrs)||0);
                    const tAmt = t > 0 ? `$ ${(t * 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
                    return (
                      <tr className="font-bold bg-neutral-50">
                        <td className="border border-gray-400 px-3 py-1 text-sm">Total</td>
                        <td className="border border-gray-400 px-1 py-1 text-center text-sm">{t > 0 ? t : "—"}</td>
                        <td className="border border-gray-400 px-3 py-1 text-center text-sm text-neutral-700">{tAmt}</td>
                      </tr>
                    );
                  })()}
                  {[
                    { label: "RM",  hrs: icRmHrs,  setHrs: setIcRmHrs  },
                    { label: "AE",  hrs: icAeHrs,  setHrs: setIcAeHrs  },
                    { label: "FIA", hrs: icFiaHrs, setHrs: setIcFiaHrs },
                  ].map(({ label, hrs, setHrs }) => {
                    const n = parseFloat(hrs);
                    const amt = !isNaN(n) && hrs !== "" ? `$ ${(n * 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
                    return (
                      <tr key={label}>
                        <td className="border border-gray-400 px-3 py-1 text-sm">{label}</td>
                        <td className="border border-gray-400 px-1 py-1 text-center">
                          <input type="text" placeholder="—"
                            value={hrs} onChange={e => setHrs(e.target.value)}
                            className="w-full text-center text-sm outline-none bg-transparent" />
                        </td>
                        <td className="border border-gray-400 px-3 py-1 text-center text-sm text-neutral-700">
                          {amt}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>) : (
              <div className="border border-gray-200 rounded px-6 py-8 text-center text-sm text-gray-400 animate-pulse w-full xl:w-[520px]">
                Loading team supply data…
              </div>
            )}
          </div>

          {/* Technical Support Works + Supply vs Demand */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div className="overflow-x-auto">
            <table className="border-collapse w-full text-sm" style={{ minWidth: '600px' }}>
              <thead>
                <tr>
                  <td colSpan={9} className="border border-gray-400 px-3 py-3 text-center font-bold text-base bg-slate-800 text-white">
                    TECHNICAL SUPPORT WORKS
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                    OTHER BILLABLE WORK SCHEDULED TO TECH TEAMS (100 Per Hour)
                    <div className="font-normal mt-1">(RM JOBS / DRAFTING JOBS / BILLABLE ESTIMATION)</div>
                  </td>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                    INVESTED TIME (100 Per Hour)
                    <div className="font-normal mt-1">(TRAINING / COURSES, Non Billable Assigned And Nil Charge Estimates to Tech Team)</div>
                  </td>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                    Quality Assurance — Overall Total of Jobs in SimPRO (100 Per Hour)
                  </td>
                </tr>
                <tr>
                  {[0, 1, 2].map(g => (
                    <React.Fragment key={g}>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}># of Jobs</th>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}>Sum of Est. Hrs</th>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}>Amount</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {/* Other Billable — auto-fetched */}
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{obData ? obData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{obData ? obData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{obData ? fmtAmt(obData.amount) : "—"}</td>
                  {/* Invested Time — auto-fetched */}
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{itData ? itData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{itData ? itData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{itData ? fmtAmt(itData.amount) : "—"}</td>
                  {/* Quality Assurance — auto-fetched */}
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{qaData ? qaData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{qaData ? qaData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center text-sm">{qaData ? fmtAmt(qaData.amount) : "—"}</td>
                </tr>
                <tr className="font-bold" style={{ backgroundColor: "#f1f5f9" }}>
                  <td className="border border-gray-400 px-2 py-2 text-center">{obData ? obData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{obData ? obData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{obData ? fmtAmt(obData.amount) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{itData ? itData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{itData ? itData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{itData ? fmtAmt(itData.amount) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{qaData ? qaData.jobs : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{qaData ? qaData.hours.toFixed(2) : "—"}</td>
                  <td className="border border-gray-400 px-2 py-2 text-center">{qaData ? fmtAmt(qaData.amount) : "—"}</td>
                </tr>
              </tbody>
            </table>
            </div>
            {/* Supply vs Demand */}
            {(() => {
              const allMembers   = [...team.filter(m => !hiddenCoreIds.has(m.id)), ...extraTeam];
              const supplyAudit  = allMembers.filter(m => m.role.includes("Primary APFS"))
                .reduce((s, m) => s + getMonthHours(m) + (isFutureMonthFilter ? m.monthlyHours : 0), 0);
              const supplyTech   = allMembers.filter(m => !m.role.includes("Primary APFS"))
                .reduce((s, m) => s + getMonthHours(m) + (isFutureMonthFilter ? m.monthlyHours : 0), 0);
              const demandAudit  = [1, 8, 10].reduce((sum, coId) => {
                const getH = coId === 8 ? jobHoursAfac : coId === 1 ? jobHoursRm : hrsForJob;
                return sum + visibleCo(coId).filter(isInAnyRow).reduce((s, j) => s + getH(j), 0);
              }, 0) + (afacProspect?.hours ?? 0);
              const icSum        = (parseFloat(icRmHrs)||0) + (parseFloat(icAeHrs)||0) + (parseFloat(icFiaHrs)||0);
              const demandTech   = (obData?.hours ?? 0) + (itData?.hours ?? 0) + (qaData?.hours ?? 0) + icSum;
              const excessAudit     = demandAudit - supplyAudit;
              const excessDaysAudit = excessAudit / 8;
              const excessTech      = demandTech - supplyTech;
              const excessDaysTech  = excessTech / 8;
              const supplyOverall   = supplyAudit + supplyTech;
              const demandOverall   = demandAudit + demandTech;
              const varianceHours   = demandOverall - supplyOverall;
              const varianceDays    = varianceHours / 8;
              const varianceWeeks   = varianceDays / 5;
              const fmtN = (n: number) => n >= 0 ? n.toFixed(2) : `-(${Math.abs(n).toFixed(2)})`;
              const fmtV = (n: number) => n.toFixed(2);
              const excessStyle = { backgroundColor: "#e9d5ff" };
              const supplyStyle = { backgroundColor: "#fef08a" };
              const overallHeaderStyle = { backgroundColor: "#1e293b", color: "#fff" };
              const varianceStyle = { backgroundColor: "#fde68a" };
              return (
                <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row gap-4">
                  {/* AFSS Audits Supply vs Demand */}
                  <table className="border-collapse text-sm flex-1">
                    <thead>
                      <tr>
                        <td colSpan={2} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                          AFSS Audits<br />SUPPLY VS DEMAND
                        </td>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Supply Hours Audits</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{supplyAudit.toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Demand Hours Audits</td>
                        <td className="border border-gray-400 px-3 py-2 text-center text-sm font-bold">{demandAudit.toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Excess Demand Hours Audits</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{Math.abs(excessAudit).toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Excess Demand Days Audits</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{Math.abs(excessDaysAudit).toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                  {/* Technical Works + Prospect Demand Supply vs Demand */}
                  <table className="border-collapse text-sm flex-1">
                    <thead>
                      <tr>
                        <td colSpan={2} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                          Technical Works + Prospect Demand<br />SUPPLY VS DEMAND
                        </td>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Supply Hours Technical</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{supplyTech.toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Demand Hours Technical</td>
                        <td className="border border-gray-400 px-3 py-2 text-center text-sm font-bold">{demandTech.toFixed(2)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Excess Demand Hours</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{fmtN(excessTech)}</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Excess Demand Days</td>
                        <td className="border border-gray-400 px-3 py-2 text-center font-bold text-sm">{fmtN(excessDaysTech)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* AFAC Prospect Demand + Overall Demand VS Supply */}
                <div className="flex flex-col sm:flex-row gap-4">
                {/* AFAC Prospect Demand */}
                <table className="border-collapse text-sm flex-1">
                  <thead>
                    <tr>
                      <td colSpan={3} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#1e293b", color: "#fff" }}>
                        AFAC Prospect Demand<br /><span className="font-normal text-xs">NOT YET WON BUT ASSUMED WILL BE NEEDED</span>
                      </td>
                    </tr>
                    <tr>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}># of Jobs</th>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}>Sum of Est. Hrs</th>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#f1f5f9" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-gray-400 px-3 py-2 text-center text-sm font-bold">
                        {afacProspect ? afacProspect.jobs : "—"}
                      </td>
                      <td className="border border-gray-400 px-3 py-2 text-center text-sm font-bold">
                        {afacProspect ? afacProspect.hours.toFixed(2) : "—"}
                      </td>
                      <td className="border border-gray-400 px-3 py-2 text-center text-sm font-bold">
                        {afacProspect ? `$ ${(afacProspect.hours * 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={3} className="border border-gray-400 px-3 py-2 text-xs text-gray-500 italic text-center">
                        {afacProspect
                          ? `AFAC Chubb Previous Years Scheduled (${new Date(afacProspect.dateFrom + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })} – ${new Date(afacProspect.dateTo + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })})`
                          : "AFAC Chubb Previous Years Scheduled (Last Year Reporting Period)"}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={3} className="border border-gray-400 px-3 py-2">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-neutral-600">Exclude dates:</span>
                            <input
                              type="date"
                              value={afacExcDate}
                              onChange={e => setAfacExcDate(e.target.value)}
                              className="text-xs border border-gray-300 rounded px-1.5 py-0.5"
                            />
                            <button
                              onClick={() => {
                                if (!afacExcDate || afacExclusions.includes(afacExcDate)) return;
                                const newList = [...afacExclusions, afacExcDate].sort();
                                setAfacExcDate("");
                                saveAfacExclusions(newList);
                              }}
                              disabled={afacExcSaving}
                              className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                            >{afacExcSaving ? "Saving…" : "Add"}</button>
                            {afacExcSaved && (
                              <span className="text-xs text-green-600 font-semibold">Saved ✓</span>
                            )}
                          </div>
                          {afacExclusions.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {afacExclusions.map(d => (
                                <span key={d} className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                                  {new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                                  <button onClick={() => saveAfacExclusions(afacExclusions.filter(x => x !== d))} className="hover:text-red-900 font-bold">×</button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {/* Overall Demand VS Supply */}
                <table className="border-collapse text-sm flex-1" style={{ minWidth: 320 }}>
                    <thead>
                      <tr>
                        <td colSpan={2} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={overallHeaderStyle}>
                          Overall Demand VS Supply
                        </td>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-bold text-center">{supplyOverall.toFixed(2)}</td>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Supply Overall</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm text-center font-bold">{demandOverall.toFixed(2)}</td>
                        <td className="border border-gray-400 px-3 py-2 text-sm">Demand Overall</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-bold text-center">{fmtV(varianceHours)}</td>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Variance in Man Hours</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-bold text-center">{fmtV(varianceDays)}</td>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Variance in Days</td>
                      </tr>
                      <tr>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-bold text-center">{fmtV(varianceWeeks)}</td>
                        <td className="border border-gray-400 px-3 py-2 text-sm font-semibold">Variance in Man Weeks</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                </div>
              );
            })()}
          </div>

      </div>
    </div>
  );
}
