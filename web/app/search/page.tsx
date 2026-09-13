import Link from "next/link";
import { Tag } from "../../components/bits.tsx";
import { SourceLink } from "../../components/sources.tsx";
import { loadSearch } from "../../lib/queries.ts";
import { confidenceDisplay, formatDateKey, sectionLabel } from "../../lib/format.ts";
import { preview } from "../../lib/untrusted.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "Search — SignalForge" };

export default async function SearchPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const params = await searchParams;
	const raw = params["q"];
	const query = (Array.isArray(raw) ? raw[0] : raw) ?? "";
	const { briefHits, itemHits } = await loadSearch(query);
	const trimmed = query.trim();

	return (
		<>
			<h1>Search</h1>
			<p className="lede">
				Postgres full-text search over published brief stories and collected items. Ranking is
				<code> ts_rank</code> over the stored tsvector columns — reproducible, inspectable, and
				with no model involved.
			</p>
			<form action="/search" method="get" role="search">
				<input
					type="search"
					name="q"
					defaultValue={trimmed}
					placeholder="e.g. inference pricing"
					aria-label="Search query"
				/>
				<button type="submit">Search</button>
			</form>

			{trimmed === "" ? (
				<p className="lede">Enter a query to search.</p>
			) : (
				<>
					<p className="dateline">
						{briefHits.length} brief stor{briefHits.length === 1 ? "y" : "ies"} ·{" "}
						{itemHits.length} collected item{itemHits.length === 1 ? "" : "s"} for “{trimmed}”
					</p>

					{briefHits.length > 0 ? (
						<section aria-labelledby="hits-briefs">
							<h2 id="hits-briefs">Brief Stories</h2>
							{briefHits.map((hit) => {
								const confidence = confidenceDisplay(hit.confidence);
								return (
									<article key={`${hit.date}:${hit.storyId}`} className="story">
										<h3>
											<Link href={`/story/${encodeURIComponent(hit.storyId)}`}>
												{hit.title}
											</Link>
										</h3>
										<p className="meta">
											<Link href={`/brief/${hit.date}`}>{formatDateKey(hit.date)}</Link>
											<Tag>{sectionLabel(hit.section)}</Tag>
											{hit.mustKnow ? <Tag tone="accent">Must know</Tag> : null}
											<Tag tone={confidence.tone}>信心 {confidence.label}</Tag>
											<span className="host">rank {hit.rank.toFixed(4)}</span>
										</p>
										<p>{preview(hit.whatHappened, 260)}</p>
									</article>
								);
							})}
						</section>
					) : null}

					{itemHits.length > 0 ? (
						<section aria-labelledby="hits-items">
							<h2 id="hits-items">Collected Items</h2>
							<ul className="sources">
								{itemHits.map(({ item, rank }) => (
									<li key={item.id}>
										<SourceLink item={item} />
										<span className="host"> · rank {rank.toFixed(4)}</span>
										{item.summary ? <div className="host">{preview(item.summary, 180)}</div> : null}
									</li>
								))}
							</ul>
						</section>
					) : null}

					{briefHits.length === 0 && itemHits.length === 0 ? (
						<p className="lede">
							Nothing matched. Full-text search is literal: try a different word from the
							source text rather than a paraphrase.
						</p>
					) : null}
				</>
			)}
		</>
	);
}
