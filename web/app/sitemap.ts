import type { MetadataRoute } from "next";
import { loadSitemapEntries } from "../lib/queries.ts";
import { absoluteUrl } from "../lib/site.ts";

/*
 * Rebuilt per request rather than cached: a sitemap that lags the morning run
 * is a sitemap that omits today, which is the one day a crawler most wants.
 * The two queries behind it are a summary scan and a grouped id list, both
 * cheap, and crawlers fetch this rarely.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A brief is immutable once published; a story page changes while it develops. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const { briefs, stories } = await loadSitemapEntries();
	const latest = briefs[0]?.producedAt;

	const fixed: MetadataRoute.Sitemap = [
		{ url: absoluteUrl("/"), lastModified: latest, changeFrequency: "daily", priority: 1 },
		{ url: absoluteUrl("/history"), lastModified: latest, changeFrequency: "daily", priority: 0.5 },
		{ url: absoluteUrl("/signals"), lastModified: latest, changeFrequency: "daily", priority: 0.5 },
	];

	const briefUrls: MetadataRoute.Sitemap = briefs.map((b) => ({
		url: absoluteUrl(`/brief/${b.date}`),
		lastModified: b.producedAt,
		changeFrequency: "monthly",
		priority: 0.8,
	}));

	const storyUrls: MetadataRoute.Sitemap = stories.map((s) => ({
		url: absoluteUrl(`/story/${encodeURIComponent(s.storyId)}`),
		lastModified: s.lastDate,
		changeFrequency: "weekly",
		priority: 0.6,
	}));

	return [...fixed, ...briefUrls, ...storyUrls];
}
