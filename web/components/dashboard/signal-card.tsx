import Link from "next/link";
import type { SignalCardView } from "../../lib/dashboard.ts";
import { confidenceLabel, signalStateLabel } from "../../lib/format.ts";

const STATE_ARROW: Record<string, string> = {
	emerging: "↗",
	strengthening: "↑",
	confirmed: "✓",
	fading: "↓",
};

/**
 * Rendered only when the brief carries at least one signal; never a placeholder.
 *
 * The heading says "值得觀察" rather than anything that sounds settled: most of
 * these rest on a day or two of evidence, and each entry states that evidence
 * (events, sources, days) next to the confidence so a reader can weigh it.
 *
 * Not boxes: a signal is one of several in a list, and hairlines separate them.
 * The state is the coloured line under the title, the evidence a quiet line
 * under the summary.
 */
export function EmergingSignals({ signals }: { signals: readonly SignalCardView[] }) {
	if (signals.length === 0) return null;
	return (
		<section className="block" aria-labelledby="emerging-signals">
			<h2 id="emerging-signals" className="block-label">
				值得觀察的趨勢
			</h2>
			<ul className="signal-list">
				{signals.map((signal) => (
					<EmergingSignalCard key={signal.label} signal={signal} />
				))}
			</ul>
		</section>
	);
}

export function EmergingSignalCard({ signal }: { signal: SignalCardView }) {
	const evidence = [
		`${signal.storyCount} 個事件`,
		`${signal.sourceCount} 個來源`,
		signal.daySpan === undefined ? undefined : `${signal.daySpan} 天`,
	].filter((part): part is string => part !== undefined);
	return (
		<li className="signal-card">
			<h3 className="signal-title">
				<Link href="/signals">{signal.label}</Link>
			</h3>
			{signal.state ? (
				<p className={`signal-state state-${signal.state}`}>
					{signalStateLabel(signal.state)}{" "}
					<span aria-hidden="true">{STATE_ARROW[signal.state] ?? ""}</span>
				</p>
			) : null}
			<p className="signal-summary">{signal.summary}</p>
			<p className="signal-evidence">
				{signal.confidence ? (
					<span className="signal-evidence-part">
						可信度{confidenceLabel(signal.confidence).replace(/^可信度/, "")}
					</span>
				) : null}
				<span className="signal-evidence-part">目前依據 {evidence.join(" · ")}</span>
			</p>
		</li>
	);
}
