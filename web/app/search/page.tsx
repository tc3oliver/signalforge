import Link from "next/link";
import { ConfidenceBadge } from "../../components/badges.tsx";
import type { ConfidenceLevel } from "../../../src/schemas/brief.ts";
import { SourceLink } from "../../components/sources.tsx";
import { loadSearch } from "../../lib/queries.ts";
import { formatDateKey, sectionLabel } from "../../lib/format.ts";
import { preview } from "../../lib/untrusted.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/*
 * Noindex: every distinct `?q=` is a separate URL with near-identical chrome
 * and content that exists elsewhere on the site. Indexing them competes with
 * the story pages that are the real answer. `follow` is kept so a crawler that
 * lands here still walks through to those pages.
 */
export const metadata = {
	title: "搜尋 — SignalForge",
	robots: { index: false, follow: true },
	alternates: { canonical: "/search" },
};

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
			<h1>搜尋</h1>
			<p className="lede">
				全文搜尋已發布的事件與收集到的項目。結果由 Postgres 直接排序，可重現、可檢查，沒有模型參與。
			</p>
			<form action="/search" method="get" role="search" className="ref-search-form">
				<input
					type="search"
					name="q"
					defaultValue={trimmed}
					placeholder="例如：inference pricing"
					aria-label="搜尋關鍵字"
				/>
				<button type="submit">搜尋</button>
			</form>

			{trimmed === "" ? (
				<p className="lede">輸入關鍵字開始搜尋。</p>
			) : (
				<>
					<p className="dateline">
						「{trimmed}」：{briefHits.length} 則事件 · {itemHits.length} 筆收集項目
					</p>

					{briefHits.length > 0 ? (
						<section aria-labelledby="hits-briefs">
							<h2 id="hits-briefs">事件</h2>
							{briefHits.map((hit) => {
								return (
									<article key={`${hit.date}:${hit.storyId}`} className="search-hit">
										<h3>
											<Link href={`/story/${encodeURIComponent(hit.storyId)}`}>
												{hit.title}
											</Link>
										</h3>
										<p className="meta">
											<Link href={`/brief/${hit.date}`}>{formatDateKey(hit.date)}</Link>
											<span>{sectionLabel(hit.section)}</span>
											{hit.mustKnow ? <span className="must-know-flag">必看</span> : null}
											<ConfidenceBadge level={hit.confidence as ConfidenceLevel} />
										</p>
										<p className="search-hit-preview">{preview(hit.whatHappened, 260)}</p>
									</article>
								);
							})}
						</section>
					) : null}

					{itemHits.length > 0 ? (
						<section aria-labelledby="hits-items">
							<h2 id="hits-items">收集項目</h2>
							<ul className="sources">
								{itemHits.map(({ item }) => (
									<li key={item.id}>
										<SourceLink item={item} />
										{item.summary ? <div className="host">{preview(item.summary, 180)}</div> : null}
									</li>
								))}
							</ul>
						</section>
					) : null}

					{briefHits.length === 0 && itemHits.length === 0 ? (
						<p className="lede">
							沒有符合的結果。全文搜尋比對的是原文用字，換一個原文中出現過的詞再試，不要用改寫的說法。
						</p>
					) : null}
				</>
			)}
		</>
	);
}
