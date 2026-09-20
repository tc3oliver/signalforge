import Link from "next/link";
import { loadSignals } from "../../lib/queries.ts";
import {
	confidenceLabel,
	confidenceLevelFromScore,
	formatInstant,
	signalStateLabel,
} from "../../lib/format.ts";
import type { SignalState } from "../../../src/db/signals.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = {
	title: "趨勢 — SignalForge",
	description: "跨多天浮現的主題：哪些事件在互相印證，依據多少來源，可信度如何。",
	alternates: { canonical: "/signals" },
};

/** Lifecycle order, strongest first; a fading signal belongs at the bottom. */
const STATE_ORDER: readonly SignalState[] = ["confirmed", "strengthening", "emerging", "fading"];

export default async function SignalsPage() {
	const { signals, storyTitles, knownStoryIds } = await loadSignals();
	if (signals.length === 0) {
		return (
			<>
				<h1>值得觀察的趨勢</h1>
				<p className="lede">目前還沒有追蹤中的趨勢。</p>
			</>
		);
	}
	return (
		<>
			<h1>值得觀察的趨勢</h1>
			<p className="dateline">
				追蹤中 {signals.length} 個 · 每個趨勢都保留最初出現的日期，直到淡出為止
			</p>
			{STATE_ORDER.map((state) => {
				const group = signals.filter((signal) => signal.state === state);
				// A lifecycle stage with nothing in it is omitted, not shown empty.
				if (group.length === 0) return null;
				return (
					<section key={state} aria-labelledby={`state-${state}`}>
						<h2 id={`state-${state}`}>{signalStateLabel(state)}</h2>
						{group.map((signal) => (
							<article key={signal.signalId} className="signal">
								<h3>{signal.label}</h3>
								<p className="meta">
									<span className={`signal-state state-${signal.state}`}>
										{signalStateLabel(signal.state)}
									</span>
									<span>{confidenceLabel(confidenceLevelFromScore(signal.confidence))}</span>
									<span>首次出現 {formatInstant(signal.firstSeenAt)}</span>
									<span>最近更新 {formatInstant(signal.lastSeenAt)}</span>
								</p>
								{signal.rationale ? (
									<p className="signal-rationale">{signal.rationale}</p>
								) : null}
								{signal.storyIds.length > 0 ? (
									<>
										<span className="signal-label">相關事件</span>
										<ol className="timeline compact">
											{signal.storyIds.map((storyId) => (
												<li key={storyId}>
													<Link href={`/story/${encodeURIComponent(storyId)}`}>
														{storyTitles.get(storyId) ?? storyId}
													</Link>
													{knownStoryIds.has(storyId) ? null : (
														<span className="host">（找不到對應的事件記錄）</span>
													)}
												</li>
											))}
										</ol>
									</>
								) : (
									<p className="lede">這個趨勢目前還沒有連結到任何事件。</p>
								)}
							</article>
						))}
					</section>
				);
			})}
		</>
	);
}
