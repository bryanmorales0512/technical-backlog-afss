export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV !== "development") {
    const { warmAll } = await import("./app/lib/simpro");
    const { warmLeave } = await import("./app/api/leave/core");
    const { warmTechSupport } = await import("./app/api/tech-support/core");
    const { warmAfacProspect } = await import("./app/api/afac-prospect/core");

    // warmAll() runs FIRST (sequentially) — it exhausts SimPRO's rate limit for 5-8 min.
    // Running tech-support/leave/afac-prospect in parallel with warmAll() causes 429 errors
    // that prevent tentative staff IDs and section CC names from being fetched correctly.
    // After warmAll() completes, the rate limit has recovered and the rest succeed reliably.
    // warmAll() runs first — exhausts SimPRO rate limit for 5-8 min.
    // warmTechSupport() runs AFTER warmAll() completes so rate limit has recovered:
    // - getTentativeStaffIds() can fetch all pages → finds TENTATIVE-RYAN G (staffId 1071)
    // - resolveUnknownCcNames() section lookups succeed → new CC IDs resolved
    await warmAll();
    // 60s recovery: warmAll() exhausts SimPRO rate limit. Waiting here lets it
    // recover so warmTechSupport() section CC lookups succeed on first attempt.
    await new Promise(r => setTimeout(r, 60_000));
    await Promise.allSettled([warmLeave(), warmTechSupport(), warmAfacProspect()]);
  }
}
