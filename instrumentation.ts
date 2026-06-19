export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV !== "development") {
    const { warmAll } = await import("./app/lib/simpro");
    const { warmLeave } = await import("./app/api/leave/core");
    const { warmTechSupport } = await import("./app/api/tech-support/core");
    const { warmAfacProspect } = await import("./app/api/afac-prospect/core");

    // Run warmup entirely in the background so the server becomes ready immediately
    // and Cloud Run health checks pass. The dashboard handles missing cache gracefully
    // (shows loading state on first visit, data appears once warmup completes).
    (async () => {
      await warmAll();
      // 60s recovery: warmAll() exhausts SimPRO rate limit. Waiting here lets it
      // recover so warmTechSupport() section CC lookups succeed on first attempt.
      await new Promise(r => setTimeout(r, 60_000));
      await Promise.allSettled([warmLeave(), warmTechSupport(), warmAfacProspect()]);
    })().catch(e => console.error("[warmup] failed:", e));
  }
}
