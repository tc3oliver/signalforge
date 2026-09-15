import type { DashboardView } from "../../lib/dashboard.ts";
import { formatCount } from "../../lib/format.ts";

/*
 * The last thing on the Today page: what it took to make it. The hero says how
 * much there is to read; this says how much there was, and how much of it the
 * reader was spared. Every number is a count the pipeline recorded — items the
 * curator decided on, collectors that fetched, ledger rows it wrote — so the
 * paragraph is evidence of the day's work, not a claim about it.
 */
export function DayInReview({ workload }: { workload: DashboardView["workload"] }) {
	if (!workload || workload.itemsScanned === 0) return null;
	const share = Math.max(1, Math.round((workload.storiesKept / workload.itemsScanned) * 100));
	return (
		<section className="day-in-review" aria-labelledby="day-in-review">
			<h2 id="day-in-review" className="block-label">
				今天讀了多少
			</h2>
			<p>
				今天讀了 <strong>{formatCount(workload.itemsScanned)}</strong> 則項目
				{workload.sources > 0 ? (
					<>
						，來自 <strong>{workload.sources}</strong> 個來源
					</>
				) : null}
				。其中 <strong>{formatCount(workload.irrelevant)}</strong> 則與追蹤的主題無關、
				<strong>{formatCount(workload.duplicate)}</strong> 則是重複報導，都沒有進來；剩下的歸成{" "}
				<strong>{workload.storiesKept}</strong> 則事件
				{workload.unchangedStories > 0 ? (
					<>
						，另有 <strong>{workload.unchangedStories}</strong> 則只是舊聞再報導，已略過
					</>
				) : null}
				。這一頁是全部的 <strong>{share}%</strong>。
			</p>
		</section>
	);
}
