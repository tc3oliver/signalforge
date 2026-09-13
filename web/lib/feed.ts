import type { BriefSummary } from "../../src/db/briefs.ts";
import { escapeXmlText } from "./untrusted.ts";

/*
 * The one place in this app that builds markup by concatenating strings, so it
 * is also the one place where escaping is a manual obligation. A brief headline
 * is a story title, which is derived from an untrusted source title, so every
 * interpolation below goes through escapeXmlText — without exception.
 */

export interface FeedOptions {
	/** Absolute base for links, e.g. "http://127.0.0.1:3300". */
	baseUrl: string;
	title?: string;
}

function absolute(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function buildBriefFeedXml(
	briefs: readonly BriefSummary[],
	options: FeedOptions,
): string {
	const title = options.title ?? "SignalForge";
	const self = absolute(options.baseUrl, "/feed.xml");
	const updated = briefs[0]?.producedAt ?? new Date(0).toISOString();

	const entries = briefs.map((brief) => {
		const link = absolute(options.baseUrl, `/brief/${encodeURIComponent(brief.date)}`);
		const summary =
			`${brief.storyCount} stories, ${brief.mustKnowCount} must-know` +
			(brief.headline ? ` — ${brief.headline}` : "");
		return [
			"\t<entry>",
			`\t\t<title>${escapeXmlText(`${title} — ${brief.date}`)}</title>`,
			`\t\t<id>${escapeXmlText(link)}</id>`,
			`\t\t<link rel="alternate" href="${escapeXmlText(link)}"/>`,
			`\t\t<updated>${escapeXmlText(brief.producedAt)}</updated>`,
			`\t\t<summary>${escapeXmlText(summary)}</summary>`,
			"\t</entry>",
		].join("\n");
	});

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<feed xmlns="http://www.w3.org/2005/Atom">',
		`\t<title>${escapeXmlText(title)}</title>`,
		`\t<id>${escapeXmlText(absolute(options.baseUrl, "/"))}</id>`,
		`\t<link rel="self" href="${escapeXmlText(self)}"/>`,
		`\t<updated>${escapeXmlText(updated)}</updated>`,
		...entries,
		"</feed>",
		"",
	].join("\n");
}
