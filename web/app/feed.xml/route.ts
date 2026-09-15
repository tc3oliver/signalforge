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
			/*
			 * The feed is a list of published days, not a live resource, so a reader
			 * polling every few minutes should hit its own cache, not Postgres.
			 *
			 * `private`, not `public`: every link in the body embeds the origin this
			 * request arrived on, so a shared cache could serve a LAN-derived feed to
			 * a public subscriber -- broken links, and this host's internal address
			 * handed out by the edge. Browser caches are origin-keyed and unaffected.
			 */
			"cache-control": "private, max-age=300",
		},
	});
}
