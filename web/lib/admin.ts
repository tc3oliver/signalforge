/**
 * The admin section exposes the pipeline's own operational record: run status,
 * model fallbacks, collector health, and per-item trace. None of it mutates
 * anything, but all of it describes how this deployment is configured and what
 * it failed at, which is not something a public reader should see.
 *
 * So it is off unless explicitly switched on. A deployment that is reachable by
 * anyone gets the reader only; an operator running it locally sets
 * SIGNALFORGE_ADMIN=1 and gets the diagnostics back.
 */
export function adminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env["SIGNALFORGE_ADMIN"]?.trim().toLowerCase();
	return raw === "1" || raw === "true";
}

export const ADMIN_ENABLED: boolean = adminEnabled();
