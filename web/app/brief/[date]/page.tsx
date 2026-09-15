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

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }) {
	const { date } = await params;
	return { title: `SignalForge — ${DATE_KEY.test(date) ? formatDateKey(date) : date}` };
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
