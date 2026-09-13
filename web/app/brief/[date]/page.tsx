import { notFound } from "next/navigation";
import { BriefView } from "../../../components/brief-view.tsx";
import { loadBriefPage } from "../../../lib/queries.ts";
import { formatDateKey } from "../../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }) {
	const { date } = await params;
	return { title: `Daily Intelligence — ${DATE_KEY.test(date) ? formatDateKey(date) : date}` };
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
	if (!data) notFound();
	return <BriefView data={data} />;
}
