import type { DashboardView } from "../../lib/dashboard.ts";
import { formatCount } from "../../lib/format.ts";

/*
 * The last thing on the Today page: what it took to make it. The hero says how
 * much there is to read; this says how much there was, and how much of it the
 * reader was spared. Every number is a count the pipeline recorded — items
 * collected, items screened out, items the curator decided on, ledger rows it
 * wrote — so the paragraph is evidence of the day's work, not a claim about it.
 *
 * Two things this must not do, both of which it used to.
 *
 * It must not treat what the curator scanned as what the day collected. Since
 * routing, a cheap screener sets aside roughly half the items before the
 * curator sees them, so "scanned" understates the day by however much was
 * withheld — on 2026-09-19, by 409 of 993.
 *
 * It must not subtract item counts and call the remainder a number of events.
 * Candidate items become ledger stories, a few of those are selected as
 * material, and fewer still reach the brief; collapsing those stages reads as
 * though 193 items turned into 13 events. For the same reason there is no
 * "this page is N% of everything": stories divided by items is not a share of
 * anything, and routing would make it drift upward on its own.
 */
export function DayInReview({ workload }: { workload: DashboardView["workload"] }) {
	if (!workload || workload.manifestItems === 0) return null;
	const screened = workload.withheldItems > 0;
	return (
		<section className="day-in-review" aria-labelledby="day-in-review">
			<h2 id="day-in-review" className="block-label">
				今天讀了多少
			</h2>
			<p>
				今天收集 <strong>{formatCount(workload.manifestItems)}</strong> 則項目
				{workload.sources > 0 ? (
					<>
						，來自 <strong>{workload.sources}</strong> 個來源
					</>
				) : null}
				。
				{screened ? (
					<>
						初步篩選過濾掉 <strong>{formatCount(workload.withheldItems)}</strong> 則，
						<strong>{formatCount(workload.itemsScanned)}</strong> 則進入深度分析
					</>
				) : (
					<>
						全部 <strong>{formatCount(workload.itemsScanned)}</strong> 則都進入深度分析
					</>
				)}
				；其中 <strong>{formatCount(workload.irrelevant)}</strong> 則與追蹤的主題無關、
				<strong>{formatCount(workload.duplicate)}</strong> 則是重複報導，
				<strong>{formatCount(workload.candidates)}</strong> 則留下來歸整成{" "}
				<strong>{formatCount(workload.ledgerStories)}</strong> 則事件
				{workload.unchangedStories > 0 ? (
					<>
						，其中 <strong>{workload.unchangedStories}</strong> 則只是舊聞再報導，已略過
					</>
				) : null}
				。最後選出 <strong>{workload.storiesKept}</strong> 則值得閱讀
				{workload.mustKnow > 0 ? (
					<>
						，<strong>{workload.mustKnow}</strong> 則列為必看
					</>
				) : null}
				。
			</p>
			<ol className="day-funnel">
				<li>
					<span>收集</span>
					<strong>{formatCount(workload.manifestItems)}</strong>
					<span className="day-funnel-unit">則項目</span>
				</li>
				{screened ? (
					<li>
						<span>初步篩選後</span>
						<strong>{formatCount(workload.itemsScanned)}</strong>
						<span className="day-funnel-unit">則項目</span>
					</li>
				) : null}
				<li>
					<span>留為素材</span>
					<strong>{formatCount(workload.candidates)}</strong>
					<span className="day-funnel-unit">則項目</span>
				</li>
				<li>
					<span>歸整成</span>
					<strong>{formatCount(workload.ledgerStories)}</strong>
					<span className="day-funnel-unit">則事件</span>
				</li>
				<li>
					<span>今天的重點</span>
					<strong>{workload.storiesKept}</strong>
					<span className="day-funnel-unit">則事件</span>
				</li>
			</ol>
		</section>
	);
}
