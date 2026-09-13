import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
import { BriefView } from "../components/brief-view.tsx";
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
			<>
				<h1>SignalForge</h1>
				<p className="lede">
					No brief has been published yet. Once a run completes, the most recent brief appears
					here.
				</p>
				{ADMIN_ENABLED ? (
					<p>
						<Link href="/admin/runs">Check run status →</Link>
					</p>
				) : null}
			</>
		);
	}
	const data = await loadBriefPage(date);
	if (!data) {
		return (
			<>
				<h1>SignalForge</h1>
				<p className="lede">
					The latest brief ({date}) could not be loaded. Its rows may have been removed while
					this page was rendering.
				</p>
			</>
		);
	}
	return <BriefView data={data} />;
}
