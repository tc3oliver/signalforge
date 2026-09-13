import Link from "next/link";
import type { DashboardView } from "../../lib/dashboard.ts";

/** The opening of the daily analysis with a link to the full text on the day's page. */
export function DailyAnalysisPreview({
	analysis,
	date,
}: {
	analysis: DashboardView["analysis"];
	date: string;
}) {
	if (analysis.full === "") return null;
	return (
		<section className="block" aria-labelledby="daily-analysis">
			<h2 id="daily-analysis" className="block-label">
				今日觀察
			</h2>
			<p className="analysis-preview">{analysis.preview}</p>
			<Link href={`/brief/${date}#section-DAILY_ANALYSIS`} className="view-all">
				{analysis.truncated ? "閱讀全文" : "查看當日完整內容"} <span aria-hidden="true">→</span>
			</Link>
		</section>
	);
}
