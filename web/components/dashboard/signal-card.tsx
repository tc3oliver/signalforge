import Link from "next/link";
import type { SignalCardView } from "../../lib/dashboard.ts";
import { signalStateLabel } from "../../lib/format.ts";
import { ConfidenceBadge } from "../badges.tsx";

const STATE_ARROW: Record<string, string> = {
	emerging: "↗",
	strengthening: "↑",
	confirmed: "✓",
	fading: "↓",
};

/** Rendered only when the brief carries at least one signal; never a placeholder. */
export function EmergingSignals({ signals }: { signals: readonly SignalCardView[] }) {
	if (signals.length === 0) return null;
	return (
		<section className="block" aria-labelledby="emerging-signals">
			<h2 id="emerging-signals" className="block-label">
				{signals.length === 1 ? "Emerging signal" : "Emerging signals"}
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
		`${signal.storyCount} ${signal.storyCount === 1 ? "story" : "stories"}`,
		`${signal.sourceCount} ${signal.sourceCount === 1 ? "source" : "sources"}`,
		signal.daySpan === undefined
			? undefined
			: `${signal.daySpan} ${signal.daySpan === 1 ? "day" : "days"}`,
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
			<dl className="signal-facts">
				<div>
					<dt>Evidence</dt>
					<dd>{evidence.join(" · ")}</dd>
				</div>
				{signal.confidence ? (
					<div>
						<dt>Confidence</dt>
						<dd>
							<ConfidenceBadge level={signal.confidence} />
						</dd>
					</div>
				) : null}
			</dl>
		</li>
	);
}
