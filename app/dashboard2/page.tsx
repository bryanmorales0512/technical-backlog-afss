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
  { key: "scheduled", label: "Scheduled Awaiting to be Done",             bg: "#16a34a", color: "#fff" },
  { key: "awaiting",  label: "Awaiting Client Info",                       bg: "#2563eb", color: "#fff" },
  { key: "tentative", label: "Tentative Awaiting Scheduling",              bg: "#ca8a04", color: "#000" },
  { key: "complete",  label: "Attendance Complete/Results To Be Released",  bg: "#94a3b8", color: "#000" },
] as const;

function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

// Identifies DATACOM jobs by customer group, customer name, or tags.
function isDatacomJob(job: RawJob): boolean {
  const cg   = String(job._customerGroup ?? "").toUpperCase();
  const name = String((job.Customer as Record<string, unknown>)?.CompanyName ?? "").toUpperCase();
  const tags = ((job.Tags as Record<string, unknown>[]) ?? [])
    .map(t => String((t as Record<string, unknown>).Name ?? "").toUpperCase());
  return cg.includes("DATACOM") || name.includes("DATACOM") || tags.some(t => t.includes("DATACOM"));
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

// CHUBB/AFAC (Company 8): use Committed hours — reflects all booked audit time
// regardless of when schedule blocks fall, giving a stable demand figure.
function jobHoursAfac(job: RawJob): number {
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

function totalWorkingDaysInMonth(year: number, month: number): number {
  const lastDay = new Date(year, month, 0);
  let hours = 0;
  for (let d = new Date(year, month - 1, 1); d <= lastDay; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) hours += 8;
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

export default function Dashboard2Page() {
  const [byCompany, setByCompany] = useState<Record<number, RawJob[]>>({});
  const [loading,   setLoading]   = useState(true);
  const [hasData,   setHasData]   = useState(false);
  const [updated,   setUpdated]   = useState<Date | null>(null);
  const [isPartial, setIsPartial] = useState(false);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now,            setNow]            = useState(() => new Date());
  const [team,           setTeam]           = useState<TeamMember[]>([]);
  const [publicHolidays, setPublicHolidays] = useState<PublicHoliday[]>([]);
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

  // Technical Support Works — all three sections auto-fetched from API
  const [obData, setObData] = useState<{ jobs: number; hours: number; amount: number } | null>(null);
  const [itData, setItData] = useState<{ jobs: number; hours: number; amount: number } | null>(null);
  const [qaData, setQaData] = useState<{ jobs: number; hours: number; amount: number } | null>(null);
  const [techRefreshing, setTechRefreshing] = useState(false);
  const [refreshSecsLeft, setRefreshSecsLeft] = useState(0);

  async function load(force = false) {
    if (partialTimerRef.current) { clearTimeout(partialTimerRef.current); partialTimerRef.current = null; }
    setLoading(true);
    setIsPartial(true); // assume partial until proven otherwise — prevents wrong tentative count flash
    let anyPartial = false;
    let anyFailed  = false;
    const sfx = force ? "&force=1" : "";
    // Accumulator for this load cycle — replaced company-by-company as responses arrive
    const next: Record<number, RawJob[]> = {};

    await Promise.all(
      COMPANIES.flatMap(co =>
        (["Pending", "Progress"] as const).map(async stage => {
          try {
            const r = await fetch(`/api/data?company=${co.id}&stage=${stage}${sfx}`);
            if (r.headers.get("X-Partial") === "1") { anyPartial = true; setIsPartial(true); }
            const d = await r.json();
            if (d?.error) throw new Error(d.error); // error response — retry later
            const jobs: RawJob[] = Array.isArray(d) ? d : (d.Result ?? []);
            const mapped = jobs.map((j: RawJob) => ({ ...j, _company: co.id }));
            next[co.id] = [...(next[co.id] ?? []), ...mapped];
            // Paint the table as soon as each response lands — don't wait for all 6
            setByCompany(prev => ({ ...prev, [co.id]: next[co.id] }));
            setHasData(true);
            setUpdated(new Date());
          } catch { anyFailed = true; /* skip failed company/stage — retry triggers below */ }
        })
      )
    );

    setIsPartial(anyPartial);
    setLoading(false);
    if (anyPartial) {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      partialTimerRef.current = setTimeout(() => load(), 5_000);
    } else if (anyFailed) {
      // Some companies failed (e.g. cold cache still warming) — retry after 30 s
      // eslint-disable-next-line react-hooks/exhaustive-deps
      partialTimerRef.current = setTimeout(() => load(), 30_000);
    }
  }

  useEffect(() => {
    load(); // eslint-disable-line react-hooks/exhaustive-deps
    const t = setInterval(() => { load(false); loadAfacProspect(false); loadTechSupport(false); }, 3_600_000);
    const tRefresh = setTimeout(() => loadTechSupport(false), 90_000); // eslint-disable-line react-hooks/exhaustive-deps
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
      const stored = localStorage.getItem("d2-hiddenCoreIds");
      if (stored) setHiddenCoreIds(new Set(JSON.parse(stored) as number[]));
    } catch {}
  }, []);

  function hideCoreTeamMember(id: number) {
    setHiddenCoreIds(prev => {
      const next = new Set(prev).add(id);
      try { localStorage.setItem("d2-hiddenCoreIds", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  function loadLeave(force = false) {
    const sfx = force ? "?force=1" : "";
    fetch(`/api/leave${sfx}`).then(r => r.json()).then(d => {
      if (d.team) { setTeam(d.team); setPublicHolidays(d.publicHolidays ?? []); }
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
      .then(d => { if (d?.jobs != null) setAfacProspect(d); })
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
        if (d?.otherBillable    != null) setObData(d.otherBillable);
        if (d?.investedTime     != null) setItData(d.investedTime);
        if (d?.qualityAssurance != null) setQaData(d.qualityAssurance);
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

    // Load from cache immediately (fast). The server will rebuild in the background
    // if the cache is stale, so the next load gets fresh data automatically.
    loadTechSupport(false); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-fetch shared data when this tab becomes visible so changes made in
    // the other dashboard are reflected immediately without a manual refresh.
    function onVisible() {
      if (document.visibilityState === "visible") {
        loadIntercompany(); // eslint-disable-line react-hooks/exhaustive-deps
        loadAfacExclusions(); // eslint-disable-line react-hooks/exhaustive-deps
        loadAfacProspect(); // eslint-disable-line react-hooks/exhaustive-deps
        loadTechSupport(false); // eslint-disable-line react-hooks/exhaustive-deps
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

  // Sync month filter to URL so it survives hard reloads
  useEffect(() => {
    const url = new URL(window.location.href);
    if (monthFilter === "all") url.searchParams.delete("m");
    else url.searchParams.set("m", monthFilter);
    window.history.replaceState(null, "", url.toString());
  }, [monthFilter]);

  // Re-fetch tech support and AFAC prospect whenever month changes.
  // Reset to null so "—" shows while loading (confirms it switched months).
  // No force — use existing cache if fresh, build fresh if cache is missing.
  useEffect(() => {
    setObData(null);
    setItData(null);
    setQaData(null);
    setAfacProspect(null);
    loadTechSupport(false, monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
    loadFilterPublicHolidays(monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
    loadAfacProspect(false, monthFilter); // eslint-disable-line react-hooks/exhaustive-deps
  }, [monthFilter]);

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

  const allJobs = Object.values(byCompany).flat().filter(j => !isDatacomJob(j)).filter(j => !isBlockPlansJob(j));
  const coJobs  = (id: number) => (byCompany[id] ?? []).filter(j => !isBlockPlansJob(j));
  const filterJobs = (jobs: RawJob[]) => {
    if (monthFilter === "all") return jobs;
    const [fy, fm] = monthFilter.split("-").map(Number);
    const isFutureMonth = fy > now.getFullYear() || (fy === now.getFullYear() && fm > now.getMonth() + 1);
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const monthEndStr = `${fy}-${String(fm).padStart(2, "0")}-${String(new Date(fy, fm, 0).getDate()).padStart(2, "0")}`;
    return jobs.filter(j => {
      const due = j.DueDate as string | null;
      if (due && new Date(due).getFullYear() > fy) return false;

      const sched = j._scheduledDate as string | null;
      if (sched) {
        if (isFutureMonth) return sched >= todayStr && sched <= monthEndStr;
        const dt = new Date(sched);
        return dt.getFullYear() === fy && dt.getMonth() + 1 === fm;
      }
      // Tentative jobs (no scheduled date): include in future-month views if due date
      // is today or later — they're unscheduled work that can be planned any month.
      // Only exclude jobs whose due date is already in the past.
      if (!due) return true;
      if (isFutureMonth) return due >= todayStr;
      const dt = new Date(due);
      return dt.getFullYear() === fy && dt.getMonth() + 1 === fm;
    });
  };
  const visibleAll  = filterJobs(allJobs);
  const visibleCo   = (id: number) => filterJobs(coJobs(id)).filter(j => !isDatacomJob(j));

  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthSet = new Set<string>();
  for (const j of allJobs) {
    const date = (j._scheduledDate || j.DueDate) as string | null;
    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (key >= currentMonthKey) monthSet.add(key);
      }
    }
  }
  const monthOptions = [
    { value: "all", label: "All" },
    ...[...monthSet].sort().slice(0, 3).map(val => {
      const [y, m] = val.split("-").map(Number);
      const d = new Date(y, m - 1, 1);
      return { value: val, label: d.toLocaleString("en-AU", { month: "long", year: "numeric" }) };
    }),
  ];

  const supplyMonthDate = monthFilter === "all"
    ? now
    : (() => { const [fy, fm] = monthFilter.split("-").map(Number); return new Date(fy, fm - 1, 1); })();
  const getMonthHours = (member: TeamMember): number => {
    if (monthFilter === "all") return member.monthlyHours;
    const [fy, fm] = monthFilter.split("-").map(Number);
    if (fy === now.getFullYear() && fm === now.getMonth() + 1) return member.monthlyHours;
    const isFuture = fy > now.getFullYear() || (fy === now.getFullYear() && fm > now.getMonth() + 1);
    if (isFuture) return member.monthlyHours + totalWorkingDaysInMonth(fy, fm) - publicHolidays.length * 8;
    return totalWorkingDaysInMonth(fy, fm) - publicHolidays.length * 8;
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
          defaultValue="/dashboard2"
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
          {isPartial && !loading && (
            <span className="text-xs text-amber-500 animate-pulse shrink-0">Refreshing…</span>
          )}
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
                style={{ backgroundColor: "#c4b5fd", width: "14%" }}
              >
                TECH TEAM WORKS
              </td>
              <td
                colSpan={3}
                rowSpan={2}
                className="border border-gray-400 px-3 py-4 text-center text-sm font-medium"
                style={{ backgroundColor: "#c4b5fd", width: "21%" }}
              >
                Work Demand (Total)
              </td>
              <td colSpan={9} className="border border-gray-400 px-3 py-3 text-center font-bold text-base bg-white">
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
                  style={{ backgroundColor: i === 0 ? "#c4b5fd" : "#f0abfc", width: "21%" }}
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
                    style={{ backgroundColor: "#ede9fe" }}
                  >
                    Total Backlog as at end of period
                  </td>
                  <StatCells s={(() => { const icSum = (parseFloat(icRmHrs)||0)+(parseFloat(icAeHrs)||0)+(parseFloat(icFiaHrs)||0); const b = COMPANIES.reduce((acc, co) => { const s = agg(visibleCo(co.id).filter(isInAnyRow), co.id === 8 ? jobHoursAfac : hrsForJob, co.id === 8 ? jobPriceAfac : jobPrice); return { count: acc.count + s.count, hrs: acc.hrs + s.hrs, amt: acc.amt + s.amt }; }, { count: 0, hrs: 0, amt: 0 }); return { count: b.count + (obData?.jobs ?? 0) + (itData?.jobs ?? 0) + (qaData?.jobs ?? 0) + (afacProspect?.jobs ?? 0), hrs: b.hrs + (afacProspect?.hours ?? 0) + (obData?.hours ?? 0) + (itData?.hours ?? 0) + (qaData?.hours ?? 0) + icSum, amt: b.amt + (obData?.amount ?? 0) + (itData?.amount ?? 0) + (qaData?.amount ?? 0) + ((afacProspect?.hours ?? 0) * 100) + (icSum * 100) }; })()} bold />
                  {COMPANIES.map(co => <StatCells key={co.id} s={agg(visibleCo(co.id).filter(isInAnyRow), co.id === 8 ? jobHoursAfac : hrsForJob, co.id === 8 ? jobPriceAfac : jobPrice)} bold />)}
                </tr>

                {/* All Companies label */}
                <tr>
                  <td
                    colSpan={13}
                    className="border border-gray-400 px-2 py-1 text-center text-sm italic text-gray-500"
                    style={{ backgroundColor: "#ede9fe" }}
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
                  const all = visibleAll.filter(rowFilter);
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
                        <StatCells s={(() => { if (row.key === "complete") return zero; const base = agg(all, getHrs); if (row.key === "scheduled") return { count: base.count + (obData?.jobs ?? 0) + (itData?.jobs ?? 0), hrs: base.hrs + (obData?.hours ?? 0) + (itData?.hours ?? 0), amt: base.amt + (obData?.amount ?? 0) + (itData?.amount ?? 0) }; if (row.key === "tentative") return { count: base.count + (qaData?.jobs ?? 0) + (afacProspect?.jobs ?? 0), hrs: base.hrs + (qaData?.hours ?? 0) + (afacProspect?.hours ?? 0), amt: base.amt + (qaData?.amount ?? 0) + ((afacProspect?.hours ?? 0) * 100) }; return base; })()} />
                        {COMPANIES.map(co => {
                          const jobs = visibleCo(co.id).filter(rowFilter);
                          const coGetHrs = co.id === 8 ? jobHoursAfac : getHrs;
                          const s = agg(jobs, coGetHrs, co.id === 8 ? jobPriceAfac : jobPrice);
                          return <StatCells key={co.id} s={row.key === "complete" ? zero : s} />;
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
            <table className="border-collapse text-sm w-full xl:w-[520px]">
              <thead>
                <tr>
                  <td rowSpan={2} className="border border-gray-400 px-3 py-3 font-bold text-base text-center align-middle" style={{ backgroundColor: "#c4b5fd", width: 160 }}>
                    Technical Team Supply
                  </td>
                  <td colSpan={3} className="border border-gray-400 px-3 py-1 text-center font-semibold text-xs" style={{ backgroundColor: "#d8b4fe" }}>
                    END OF PERIOD GENERATED
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-gray-400 px-3 py-2 text-center font-bold text-base" style={{ backgroundColor: "#a855f7", color: "#fff" }}>
                    {supplyMonthDate.toLocaleString("en-AU", { month: "long" })}
                  </td>
                </tr>
                <tr>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe" }}>APFS / AUDITOR</th>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe", width: 70 }}>{supplyMonthDate.toLocaleString("en-AU", { month: "short" })}</th>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe", width: 100 }}>Total Supply Hours</th>
                  <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe", width: 190 }}>Roles</th>
                </tr>
              </thead>
              <tbody>
                {team.filter(m => !hiddenCoreIds.has(m.id)).map(member => {
                  const leaveDays  = remainingLeaveDays(member, supplyMonthDate);
                  const leaveHrs   = leaveDays * 8;
                  const netHrs     = Math.max(0, getMonthHours(member) - leaveHrs);
                  const onLeaveNow = isOnLeaveToday(member, now);
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
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{netHrs}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{getMonthHours(member)}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-xs">{member.role}</td>
                    </tr>
                  );
                })}

                {/* Extra (manager-added) team members */}
                {extraTeam.map(member => {
                  const leaveDays  = remainingLeaveDays(member, supplyMonthDate);
                  const netHrs     = Math.max(0, getMonthHours(member) - leaveDays * 8);
                  const onLeaveNow = isOnLeaveToday(member, now);
                  return (
                    <tr key={member.id} style={{ backgroundColor: "#f0fdf4" }}>
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
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{netHrs}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-sm">{getMonthHours(member)}</td>
                      <td className="border border-gray-400 px-2 py-2 text-center text-xs">{member.role}</td>
                    </tr>
                  );
                })}

                {/* Public Holidays row */}
                {publicHolidays.length > 0 && (
                  <tr>
                    <td className="border border-gray-400 px-3 py-1 text-center text-xs font-semibold text-red-600">Public Holidays</td>
                    <td className="border border-gray-400 px-2 py-1 text-center text-xs text-red-600">−{publicHolidays.length * 8}</td>
                    <td className="border border-gray-400 px-2 py-1 text-center text-xs text-red-600">−{publicHolidays.length * 8}</td>
                    <td className="border border-gray-400 px-2 py-1 text-xs text-red-600">
                      {publicHolidays.map(ph => {
                        const [, , d] = ph.date.split("-");
                        return `${ph.name} (${parseInt(d)} ${now.toLocaleString("en-AU", { month: "short" })})`;
                      }).join(" · ")}
                    </td>
                  </tr>
                )}

                {/* Total row (includes extra members) */}
                <tr className="font-bold">
                  <td className="border border-gray-400 px-3 py-2" style={{ backgroundColor: "#ede9fe" }} />
                  <td className="border border-gray-400 px-2 py-2 text-center" style={{ backgroundColor: "#ede9fe" }}>
                    {[...team.filter(m => !hiddenCoreIds.has(m.id)), ...extraTeam].reduce((s, m) => s + Math.max(0, getMonthHours(m) - remainingLeaveDays(m, supplyMonthDate) * 8), 0) - publicHolidays.length * 8}
                  </td>
                  <td className="border border-gray-400 px-2 py-2 text-center" style={{ backgroundColor: "#ede9fe" }}>
                    {[...team.filter(m => !hiddenCoreIds.has(m.id)), ...extraTeam].reduce((s, m) => s + getMonthHours(m), 0) - publicHolidays.length * 8}
                  </td>
                  <td className="border border-gray-400 px-2 py-2" style={{ backgroundColor: "#ede9fe" }} />
                </tr>

                {/* Add Member UI */}
                {!addingMember ? (
                  <tr>
                    <td colSpan={4} className="border border-gray-400 px-2 py-1 text-center">
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
                      <td colSpan={4} className="border border-gray-400 px-3 py-2" style={{ backgroundColor: "#f8fafc" }}>
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
              <div className="border border-gray-400 px-3 py-2 mb-2 text-xs text-center" style={{ backgroundColor: "#fca5a5" }}>
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
                  <td colSpan={9} className="border border-gray-400 px-3 py-3 text-center font-bold text-base bg-white">
                    TECHNICAL SUPPORT WORKS
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#c4b5fd" }}>
                    OTHER BILLABLE WORK SCHEDULED TO TECH TEAMS (100 Per Hour)
                    <div className="font-normal mt-1">(RM JOBS / DRAFTING JOBS / BILLABLE ESTIMATION)</div>
                  </td>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#c4b5fd" }}>
                    INVESTED TIME (100 Per Hour)
                    <div className="font-normal mt-1">(TRAINING / COURSES, Non Billable Assigned And Nil Charge Estimates to Tech Team)</div>
                  </td>
                  <td colSpan={3} className="border border-gray-400 px-2 py-3 text-center text-xs font-bold align-top" style={{ backgroundColor: "#f0abfc" }}>
                    Quality Assurance — Overall Total of Jobs in SimPRO (100 Per Hour)
                  </td>
                </tr>
                <tr>
                  {[0, 1, 2].map(g => (
                    <React.Fragment key={g}>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe" }}># of Jobs</th>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe" }}>Sum of Est. Hrs</th>
                      <th className="border border-gray-400 px-2 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#ede9fe" }}>Amount</th>
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
                <tr className="font-bold" style={{ backgroundColor: "#ede9fe" }}>
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
                .reduce((s, m) => s + getMonthHours(m), 0);
              const supplyTech   = allMembers.filter(m => !m.role.includes("Primary APFS"))
                .reduce((s, m) => s + getMonthHours(m), 0);
              const demandAudit  = [1, 8, 10].reduce((sum, coId) =>
                sum + visibleCo(coId).filter(isInAnyRow).reduce((s, j) => s + hrsForJob(j), 0), 0
              ) + (afacProspect?.hours ?? 0);
              const icSum        = (parseFloat(icRmHrs)||0) + (parseFloat(icAeHrs)||0) + (parseFloat(icFiaHrs)||0);
              const demandTech   = (obData?.hours ?? 0) + (itData?.hours ?? 0) + (qaData?.hours ?? 0) + icSum;
              const excessAudit     = demandAudit - supplyAudit;
              const excessDaysAudit = excessAudit / 8;
              const excessTech      = demandTech - supplyTech;
              const excessDaysTech  = excessTech / 8;
              const supplyOverall   = supplyAudit + supplyTech;
              const demandOverall   = demandAudit + demandTech;
              const varianceHours   = -(Math.abs(supplyOverall - demandOverall));
              const varianceDays    = varianceHours / 8;
              const varianceWeeks   = varianceDays / 5;
              const fmtN = (n: number) => n >= 0 ? n.toFixed(2) : `-(${Math.abs(n).toFixed(2)})`;
              const fmtV = (n: number) => n.toFixed(2);
              const excessStyle = { backgroundColor: "#e9d5ff" };
              const supplyStyle = { backgroundColor: "#fef08a" };
              const overallHeaderStyle = { backgroundColor: "#86efac" };
              const varianceStyle = { backgroundColor: "#fde68a" };
              return (
                <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row gap-4">
                  {/* AFSS Audits Supply vs Demand */}
                  <table className="border-collapse text-sm flex-1">
                    <thead>
                      <tr>
                        <td colSpan={2} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#fca5a5" }}>
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
                        <td colSpan={2} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#c4b5fd" }}>
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
                      <td colSpan={3} className="border border-gray-400 px-3 py-2 text-center font-bold text-sm" style={{ backgroundColor: "#67e8f9" }}>
                        AFAC Prospect Demand<br /><span className="font-normal text-xs">NOT YET WON BUT ASSUMED WILL BE NEEDED</span>
                      </td>
                    </tr>
                    <tr>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#e0f2fe" }}># of Jobs</th>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#e0f2fe" }}>Sum of Est. Hrs</th>
                      <th className="border border-gray-400 px-3 py-2 text-center text-xs font-semibold" style={{ backgroundColor: "#e0f2fe" }}>Amount</th>
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
