import Link from "next/link";
import { Tag } from "../../../../components/bits.tsx";
import { SourceLink } from "../../../../components/sources.tsx";
import { loadItemTrace } from "../../../../lib/queries.ts";
import { buildTraceSteps } from "../../../../lib/trace.ts";
import {
	dispositionLabel,
	formatDateKey,
	formatInstant,
	sectionLabel,
} from "../../../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return { title: `Item trace — ${decodeURIComponent(id)}` };
}

export default async function ItemTracePage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;
	const query = await searchParams;
	const rawDate = query["date"];
	const requestedDate = Array.isArray(rawDate) ? rawDate[0] : rawDate;
	const itemId = decodeURIComponent(id);
	const data = await loadItemTrace(
		itemId,
		requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : undefined,
	);

	const steps = buildTraceSteps({
		date: data.date,
		explanation: data.explanation,
		story: data.story,
		collectedAt: data.provenance?.fetchedAt,
		collectorId: data.provenance?.collectorId,
		knownToItemStore: data.provenance !== undefined,
	});

	return (
		<>
			<h1>Why did this item not reach the brief?</h1>
			<p className="dateline">
				<span className="mono">{itemId}</span> · evaluated for {formatDateKey(data.date)}
			</p>

			{data.provenance ? (
				<section className="panel" aria-labelledby="item-summary">
					<h2 id="item-summary" style={{ marginTop: 0, border: "none" }}>
						The item
					</h2>
					<p>
						<SourceLink item={data.provenance.item} />
					</p>
					<p className="meta">
						<span className="host">published {formatInstant(data.provenance.item.publishedAt)}</span>
						<span className="host">fetched {formatInstant(data.provenance.fetchedAt)}</span>
						{data.provenance.collectorId ? (
							<span className="mono host">{data.provenance.collectorId}</span>
						) : null}
						{data.provenance.externalId ? (
							<span className="mono host">external {data.provenance.externalId}</span>
						) : null}
					</p>
					{data.provenance.item.summary ? <p>{data.provenance.item.summary}</p> : null}
				</section>
			) : (
				<p className="lede">
					No normalized item with this id exists in this lineage.
				</p>
			)}

			<section aria-labelledby="item-trace">
				<h2 id="item-trace">Trace</h2>
				<ol className="trace">
					{steps.map((step) => (
						<li key={step.stage} className={step.outcome}>
							<div className="step-label">{step.stage}</div>
							<strong>{step.label}</strong>
							<div>{step.detail}</div>
							{step.storyId ? (
								<div className="meta">
									<Link href={`/story/${encodeURIComponent(step.storyId)}`}>
										open story ledger →
									</Link>
								</div>
							) : null}
						</li>
					))}
				</ol>
			</section>

			<section aria-labelledby="item-coverage">
				<h2 id="item-coverage">Scan coverage on {formatDateKey(data.date)}</h2>
				{Object.keys(data.dispositionCounts).length === 0 ? (
					<p className="lede">No decisions were recorded on this date at all.</p>
				) : (
					<p className="meta">
						{Object.entries(data.dispositionCounts).map(([disposition, count]) => (
							<Tag key={disposition}>
								{disposition} {count}
							</Tag>
						))}
					</p>
				)}
			</section>

			{data.decisions.length > 1 ? (
				<section aria-labelledby="item-dates">
					<h2 id="item-dates">Decisions on other dates</h2>
					<p className="lede">
						A disposition is per-date. The same item can be irrelevant one day and a candidate
						the next.
					</p>
					<div className="scroll-x">
						<table>
							<thead>
								<tr>
									<th>Date</th>
									<th>Disposition</th>
									<th>Story</th>
									<th>Reason</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{data.decisions.map((decision) => (
									<tr key={decision.date}>
										<td>{formatDateKey(decision.date)}</td>
										<td>{dispositionLabel(decision.disposition)}</td>
										<td className="mono">
											{decision.storyId ? (
												<Link href={`/story/${encodeURIComponent(decision.storyId)}`}>
													{decision.storyId}
												</Link>
											) : (
												"—"
											)}
										</td>
										<td>{decision.reason}</td>
										<td>
											<Link
												href={`/admin/item/${encodeURIComponent(itemId)}?date=${decision.date}`}
											>
												trace
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			) : null}

			{data.appearances.length > 0 ? (
				<section aria-labelledby="item-appearances">
					<h2 id="item-appearances">Its story in published briefs</h2>
					<ul className="plain tight">
						{data.appearances.map((appearance) => (
							<li key={appearance.date}>
								<Link href={`/brief/${appearance.date}`}>{formatDateKey(appearance.date)}</Link>{" "}
								<span className="host">
									{sectionLabel(appearance.section)} — {appearance.title}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</>
	);
}
