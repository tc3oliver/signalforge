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
				<h1 className="hero-label">還沒有內容</h1>
				<p className="hero-summary">第一次整理完成後，今天的重點會出現在這裡。</p>
				{ADMIN_ENABLED ? (
					<p>
						<Link href="/admin/runs" className="view-all">
							查看執行狀態 <span aria-hidden="true">→</span>
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
				<h1 className="hero-label">無法載入</h1>
				<p className="hero-summary">
					最新一天（{date}）的內容無法載入，資料可能在頁面產生期間被移除。
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
