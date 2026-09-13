import { buildBriefFeedXml } from "../../lib/feed.ts";
import { loadBriefHistory } from "../../lib/queries.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Atom index of published briefs. The base URL is taken from the request so the
 * feed works on whichever loopback/LAN address the reader was reached at, and
 * no public hostname has to be configured anywhere.
 */
export async function GET(request: Request): Promise<Response> {
	const briefs = await loadBriefHistory(50);
	const origin = new URL(request.url).origin;
	const xml = buildBriefFeedXml(briefs, { baseUrl: origin });
	return new Response(xml, {
		headers: {
			"content-type": "application/atom+xml; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}
