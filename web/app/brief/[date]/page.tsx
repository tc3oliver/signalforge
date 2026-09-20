import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { FullBriefView } from "../../../components/brief-view.tsx";
import { loadBriefPage } from "../../../lib/queries.ts";
import { formatDateKey } from "../../../lib/format.ts";


/*
 * A dated brief is immutable once published, so it is revalidated rather than
 * rebuilt per request. Five minutes is short enough that a republished day (a
 * rerun, a correction) reaches readers promptly and long enough that a shared
 * link does not re-query Postgres for every visitor.
 */
export const revalidate = 300;
export const runtime = "nodejs";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/*
 * A dated brief is the unit people share and the unit a search result should
 * point at, so it needs its own description and its own canonical. Inheriting
 * the site description gave every archived day an identical snippet, which is
 * the shape of a page a search engine drops as a near-duplicate.
 */
/*
 * `images` is repeated here on purpose. Next replaces a parent `openGraph`
 * wholesale rather than merging it, so a child that sets only title and
 * description silently drops the site's share image. The unhashed path is the
 * same file the root convention emits; the hash is only a cache buster.
 */
export async function generateMetadata({ params }: { params: Promise<{ date: string }> }) {
	const { date } = await params;
	if (!DATE_KEY.test(date)) return { title: "找不到這一天 — SignalForge" };
	const label = formatDateKey(date);
	// `loadBriefPage` is memoised per request, so this is the same query the
	// component below runs, not a second one.
	const data = await loadBriefPage(date);
	const stories = data?.brief.stories ?? [];
	const mustKnow = stories.filter((s) => s.mustKnow);
	const description = data
		? `${label}：${stories.length} 則事件，${mustKnow.length} 則必看` +
			(mustKnow[0] ? `，重點是「${mustKnow[0].title}」。` : "。") +
			"每則都標明發生了什麼、為什麼重要、和昨天比變了什麼，並附上出處。"
		: undefined;
	return {
		title: `SignalForge — ${label}`,
		...(description
			? {
					description,
					openGraph: { title: label, description, images: ["/opengraph-image.png"] },
				}
			: {}),
		alternates: { canonical: `/brief/${date}` },
	};
}

export default async function BriefByDatePage({
	params,
}: {
	params: Promise<{ date: string }>;
}) {
	const { date } = await params;
	// The date is a path segment and therefore user input. It is matched against
	// the stored key format before it ever reaches a query.
	if (!DATE_KEY.test(date)) notFound();
	const data = await loadBriefPage(date);
	if (!data) {
		/*
		 * A miss must not be cached. Today's page is requested before the morning
		 * run publishes -- by a crawler, by the feed, by yesterday's "next day"
		 * link -- and a cached 404 would keep the day missing for five minutes
		 * after it exists, with no invalidation anywhere in the repo to clear it.
		 * Opting this render out leaves published days on the 300s path.
		 */
		noStore();
		notFound();
	}
	return <FullBriefView data={data} />;
}
