export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV !== "development") {
    const { warmAll } = await import("./app/lib/simpro");
    const { warmLeave } = await import("./app/api/leave/core");
    const { warmTechSupport } = await import("./app/api/tech-support/core");
    const { warmAfacProspect } = await import("./app/api/afac-prospect/core");

    // Run warmup entirely in the background so the server becomes ready immediately
    // and Cloud Run health checks pass. warmAll() reads from GCS (fast) so no
    // rate-limit delay is needed before warmLeave/warmTechSupport/warmAfacProspect.
    (async () => {
      await warmAll();
      await Promise.allSettled([warmLeave(), warmTechSupport(), warmAfacProspect()]);
    })().catch(e => console.error("[warmup] failed:", e));
  }
}
