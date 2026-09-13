import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
import { TodayDashboard } from "../components/dashboard/today-dashboard.tsx";
import { buildDashboard } from "../lib/dashboard.ts";
import { loadBriefPage, loadLatestBriefDate } from "../lib/queries.ts";

/*
 * Always dynamic. The brief for "today" changes when the pipeline publishes,
 * not when this app is built, and a cached page would quietly serve yesterday.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function TodayPage() {
	const date = await loadLatestBriefDate();
	if (!date) {
		return (
			<section className="hero">
				<h1 className="hero-label">Nothing published yet</h1>
				<p className="hero-summary">
					Once a run completes, the most recent brief appears here.
				</p>
				{ADMIN_ENABLED ? (
					<p>
						<Link href="/admin/runs" className="view-all">
							Check run status <span aria-hidden="true">→</span>
						</Link>
					</p>
				) : null}
			</section>
		);
	}
	const data = await loadBriefPage(date);
	if (!data) {
		return (
			<section className="hero">
				<h1 className="hero-label">Brief unavailable</h1>
				<p className="hero-summary">
					The latest brief ({date}) could not be loaded. Its rows may have been removed while
					this page was rendering.
				</p>
			</section>
		);
	}
	const view = buildDashboard({
		brief: data.brief,
		ledger: data.ledger,
		signalRecords: data.signalRecords,
		lateItems: data.lateItems,
	});
	return <TodayDashboard view={view} />;
}
