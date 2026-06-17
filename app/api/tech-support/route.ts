import { NextResponse } from "next/server";
import {
  OB_IT_CACHE_TTL, QA_CACHE_TTL,
  scheduleCcIdRefresh, _dynamicAfssIds,
  readObItCache, writeObItCache,
  readQaCache, writeQaCache,
  buildObItDeduped, buildQaDeduped,
  aggregateQA, getQADateTo,
  getTentativeStaffIds, fetchAllScheduleBlocks, fetchJobDetailsMap,
  loadCcCache, saveCcCache, resolveUnknownCcNames,
  calcOtherBillable, calcInvestedTime,
  listOf, simGet, isAfssBlock,
} from "./core";
import type { TechSupportResponse } from "./core";

export type { TechSupportStats, QARawJob, TechSupportResponse } from "./core";

export const maxDuration = 300;

export async function GET(req: Request) {
  const url    = new URL(req.url);
  const force  = url.searchParams.get("force") === "1";
  const all    = url.searchParams.get("all")   === "1";
  const aest   = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const year   = url.searchParams.get("year")  ? Number(url.searchParams.get("year"))  : aest.getUTCFullYear();
  const month  = url.searchParams.get("month") ? Number(url.searchParams.get("month")) : aest.getUTCMonth() + 1;
  const dateTo = getQADateTo(year, month, all);

  if (url.searchParams.get("debug") === "rawday") {
    const date = url.searchParams.get("date") ?? `${year}-${String(month).padStart(2,"0")}-05`;
    const tentativeIds = await getTentativeStaffIds();
    const allStaff = listOf(await simGet(`/api/v1.0/companies/1/staff/?pageSize=250&columns=ID,Name`));
    const { fetchDayBlocks } = await import("./core");
    const blocks = await fetchDayBlocks(date);
    const jobBlocks = blocks.filter(b => b.Type === "job");
    return NextResponse.json({
      date,
      tentativeIdsFound: [...tentativeIds],
      totalStaffWithTentative: allStaff.filter(s => String(s.Name ?? "").toLowerCase().includes("tentative")).map(s => ({ id: s.ID, name: s.Name })),
      totalBlocksOnDate: blocks.length,
      jobBlocksOnDate: jobBlocks.length,
      jobBlocks: jobBlocks.map(b => ({
        staffId: (b.Staff as Record<string,unknown>)?.ID,
        staffName: (b.Staff as Record<string,unknown>)?.Name,
        jobId: (b.Project as Record<string,unknown>)?.ProjectID,
        ccId: (b.Project as Record<string,unknown>)?.CostCenterID,
        sectionId: (b.Project as Record<string,unknown>)?.SectionID,
        hours: b.TotalHours,
        type: b.Type,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.searchParams.get("debug") === "list" || url.searchParams.get("debug") === "pipeline") {
    scheduleCcIdRefresh();
    const tentativeIds = await getTentativeStaffIds();
    const afssIds = _dynamicAfssIds;
    const blockList    = await fetchAllScheduleBlocks(year, month, tentativeIds);
    const jobIds       = [...new Set(blockList.map(b => b.jobId))];
    const ccCache      = await loadCcCache();
    for (const b of blockList) {
      if (b.ccName.length > 0 && b.ccId > 0 && !ccCache.has(b.ccId)) ccCache.set(b.ccId, b.ccName);
    }
    await resolveUnknownCcNames(blockList, ccCache);
    await saveCcCache(ccCache);
    const jobMap     = await fetchJobDetailsMap(jobIds);
    const jobCcNames = ccCache;
    const ob: object[] = [];
    const it: object[] = [];
    // Dropped tracking for pipeline debug
    const droppedNotAfss:  object[] = [];
    const droppedNoJob:    object[] = [];
    const droppedBadStage: object[] = [];
    for (const b of blockList) {
      const resolvedName = b.ccName || (b.ccId > 0 && jobCcNames.has(b.ccId) ? jobCcNames.get(b.ccId)! : "");
      if (!isAfssBlock(b, jobCcNames, afssIds)) {
        droppedNotAfss.push({ jobId: b.jobId, date: b.date, staffId: b.staffId, hours: b.hours, ccName: resolvedName, ccId: b.ccId });
        continue;
      }
      const job = jobMap.get(b.jobId);
      if (!job) {
        droppedNoJob.push({ jobId: b.jobId, date: b.date, staffId: b.staffId, hours: b.hours, ccName: resolvedName, ccId: b.ccId });
        continue;
      }
      const stage = String(job.Stage ?? "").toLowerCase();
      if (stage !== "pending" && stage !== "progress") {
        droppedBadStage.push({ jobId: b.jobId, date: b.date, staffId: b.staffId, hours: b.hours, ccName: resolvedName, ccId: b.ccId, stage });
        continue;
      }
      const customer = String((job.Customer as Record<string, unknown>)?.CompanyName ?? "");
      const row = { jobId: b.jobId, date: b.date, staffId: b.staffId, hours: b.hours, ccName: resolvedName, ccId: b.ccId, customer, stage };
      const isInternal = ["REDMEN FIRE", "AFAC", "ADAIR OPERATION", "Z SAFE"].some(c => customer.toUpperCase().includes(c));
      if (isInternal) it.push(row); else ob.push(row);
    }
    const result: Record<string, unknown> = { obCount: ob.length, itCount: it.length, total: ob.length + it.length, ob, it };
    if (url.searchParams.get("debug") === "pipeline") {
      result.totalBlocksFetched = blockList.length;
      result.droppedNotAfss  = droppedNotAfss;
      result.droppedNoJob    = droppedNoJob;
      result.droppedBadStage = droppedBadStage;
      result.droppedNotAfssCount  = droppedNotAfss.length;
      result.droppedNoJobCount    = droppedNoJob.length;
      result.droppedBadStageCount = droppedBadStage.length;
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  const nodc       = url.searchParams.get("excludeDatacom") === "1";
  const obItCached = await readObItCache(year, month, nodc);
  const obItFresh  = obItCached && (Date.now() - obItCached.ts < OB_IT_CACHE_TTL);
  let obItData: { otherBillable: { jobs: number; hours: number; amount: number }; investedTime: { jobs: number; hours: number; amount: number } };
  if (force || !obItFresh) {
    try {
      const built = await buildObItDeduped(year, month, force);
      await writeObItCache(year, month, built.regular, false);
      await writeObItCache(year, month, built.nodc,    true);
      obItData = nodc ? built.nodc : built.regular;
    } catch {
      obItData = obItCached?.data ?? { otherBillable: { jobs: 0, hours: 0, amount: 0 }, investedTime: { jobs: 0, hours: 0, amount: 0 } };
    }
  } else {
    obItData = obItCached.data;
  }

  const qaCached = await readQaCache();
  const qaFresh  = qaCached && (Date.now() - qaCached.ts < QA_CACHE_TTL);
  let qaRawJobs: import("./core").QARawJob[];
  if (force || !qaFresh) {
    try {
      qaRawJobs = await buildQaDeduped(force);
      await writeQaCache(qaRawJobs);
    } catch {
      qaRawJobs = qaCached?.data ?? [];
    }
  } else {
    qaRawJobs = qaCached.data;
  }

  return NextResponse.json(
    {
      otherBillable:    obItData.otherBillable,
      investedTime:     obItData.investedTime,
      qualityAssurance: aggregateQA(qaRawJobs, dateTo),
    } satisfies TechSupportResponse,
    { headers: { "Cache-Control": "no-store" } }
  );
}
