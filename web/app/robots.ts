import { absoluteUrl } from "../lib/site.ts";

/*
 * Structurally what Next's `MetadataRoute.Robots` is, declared here rather than
 * imported from "next". Importing a type from "next" pulls that package's
 * global augmentation -- which makes `NODE_ENV` a required key of `ProcessEnv`
 * -- into every program that reaches this file, and the unit tests build
 * `process.env` replacements as plain object literals. One type import here
 * broke typechecking in eight unrelated test files.
 */
interface RobotsFile {
	rules: { userAgent: string; allow: string; disallow: string[] };
	sitemap: string;
}

/*
 * Resolved per request, not prerendered. The origin comes from the environment
 * of the running service, and the build does not share that environment: built
 * statically, this file baked in the dev fallback and published
 * `Sitemap: http://localhost:3300/sitemap.xml` to every crawler. The sitemap
 * route next to it is dynamic for the same reason and costs no more.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/*
 * There was no robots.txt at all: /robots.txt returned the app's 404 page, as
 * HTML, with a 404 status. A crawler reads that as "no rules", which is not
 * harmful on its own, but it also means nothing ever pointed at a sitemap, and
 * the parameterised /search page was as crawlable as a brief.
 *
 * /admin is already unreachable in production (ADMIN_ENABLED gates it to a 404),
 * so the Disallow below is documentation rather than a control -- it costs a
 * crawler a wasted fetch to discover the same thing.
 */
export default function robots(): RobotsFile {
	return {
		rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/search"] },
		sitemap: absoluteUrl("/sitemap.xml"),
	};
}
