import { buildBriefFeedXml } from "../../lib/feed.ts";
import { loadBriefHistory } from "../../lib/queries.ts";
import { SITE_ORIGIN } from "../../lib/site.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Atom index of published briefs.
 *
 * The base URL used to be taken from the request, so that the feed worked on
 * whichever loopback or LAN address the reader was reached at without any
 * hostname being configured. Behind the edge proxy that produced
 * `https://0.0.0.0:3300/...` -- Next binds `0.0.0.0`, and nothing rewrote it --
 * which is every entry id and every link in the public feed. An Atom id is
 * permanent: a subscriber that stored those keeps them. The configured origin
 * is the only value that is correct for the readers who actually receive this.
 */
export async function GET(): Promise<Response> {
	const briefs = await loadBriefHistory(50);
	const xml = buildBriefFeedXml(briefs, { baseUrl: SITE_ORIGIN });
	return new Response(xml, {
		headers: {
			"content-type": "application/atom+xml; charset=utf-8",
			/*
			 * The feed is a list of published days, not a live resource, so a reader
			 * polling every few minutes should hit its own cache, not Postgres.
			 *
			 * `public` is safe now that the body is built from a fixed configured
			 * origin rather than the request's: the same bytes are correct for every
			 * subscriber, so a shared cache can no longer hand a LAN-derived feed to
			 * a public reader.
			 */
			"cache-control": "public, max-age=300",
		},
	});
}
