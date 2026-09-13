import Link from "next/link";
import { Tag } from "../../components/bits.tsx";
import { loadSignals } from "../../lib/queries.ts";
import { formatInstant, formatScore, signalStateLabel } from "../../lib/format.ts";
import type { SignalState } from "../../../src/db/signals.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "Signals — SignalForge" };

/** Lifecycle order, strongest first; a fading signal belongs at the bottom. */
const STATE_ORDER: readonly SignalState[] = ["confirmed", "strengthening", "emerging", "fading"];

const STATE_TONE: Record<SignalState, "ok" | "accent" | "warn" | "neutral"> = {
	confirmed: "ok",
	strengthening: "accent",
	emerging: "neutral",
	fading: "warn",
};

export default async function SignalsPage() {
	const { signals, storyTitles } = await loadSignals();
	if (signals.length === 0) {
		return (
			<>
				<h1>Emerging Signals</h1>
				<p className="lede">No signals are being tracked yet.</p>
			</>
		);
	}
	return (
		<>
			<h1>Emerging Signals</h1>
			<p className="dateline">
				{signals.length} tracked · a signal keeps its original first-seen date for its whole
				lifecycle
			</p>
			{STATE_ORDER.map((state) => {
				const group = signals.filter((signal) => signal.state === state);
				// A lifecycle stage with nothing in it is omitted, not shown empty.
				if (group.length === 0) return null;
				return (
					<section key={state} aria-labelledby={`state-${state}`}>
						<h2 id={`state-${state}`}>{signalStateLabel(state)}</h2>
						{group.map((signal) => (
							<article key={signal.signalId} className="panel">
								<h3 style={{ marginTop: 0 }}>{signal.label}</h3>
								<p className="meta">
									<Tag tone={STATE_TONE[state]}>{signalStateLabel(signal.state)}</Tag>
									<span>confidence {formatScore(signal.confidence)}</span>
									<span className="host">first seen {formatInstant(signal.firstSeenAt)}</span>
									<span className="host">last seen {formatInstant(signal.lastSeenAt)}</span>
								</p>
								{signal.rationale ? <p>{signal.rationale}</p> : null}
								{signal.storyIds.length > 0 ? (
									<>
										<p className="field">
											<span className="field-label">Evidence stories</span>
										</p>
										<ul className="plain tight">
											{signal.storyIds.map((storyId) => (
												<li key={storyId}>
													<Link href={`/story/${encodeURIComponent(storyId)}`}>
														{storyTitles.get(storyId) ?? storyId}
													</Link>
													{storyTitles.has(storyId) ? null : (
														<span className="host"> (no ledger entry found)</span>
													)}
												</li>
											))}
										</ul>
									</>
								) : (
									<p className="lede">No evidence stories are linked to this signal yet.</p>
								)}
							</article>
						))}
					</section>
				);
			})}
		</>
	);
}
