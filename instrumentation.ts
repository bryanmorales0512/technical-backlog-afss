export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmAll } = await import("./app/lib/simpro");
    const { warmLeave } = await import("./app/api/leave/route");
    const { warmTechSupport } = await import("./app/api/tech-support/route");
    const { warmAfacProspect } = await import("./app/api/afac-prospect/route");

    // Run all warmup tasks in background — no gate blocks requests.
    // Auto-retry in the dashboard handles the brief cold-cache period.
    Promise.all([warmAll(), warmLeave(), warmTechSupport(), warmAfacProspect()]).catch(() => {});
  }
}
