/*
 * The one place that knows where this site lives.
 *
 * Four things need an absolute, public origin: the OpenGraph image, the Atom
 * feed's entry ids, robots.txt's sitemap pointer, and sitemap.xml's own URLs.
 * Before this module each derived it separately, and each got it wrong in a
 * different way -- the share card resolved against `http://localhost:3300`
 * because an env var never reached the service, while the feed took the origin
 * from `request.url` and, behind the edge proxy, published every brief id as
 * `https://0.0.0.0:3300/...`. A feed id is permanent: a subscriber that stored
 * those ids keeps them forever. One constant, read once, is the fix.
 */

/** Dev fallback. Matches the reader's own bind port so local shares resolve. */
const DEV_ORIGIN = "http://localhost:3300";

function readConfiguredOrigin(): string {
	const raw = process.env["SIGNALFORGE_SITE_URL"]?.trim();
	if (!raw) return DEV_ORIGIN;
	try {
		// Normalised to a bare origin: a trailing slash or stray path would be
		// concatenated into every feed id and sitemap URL below.
		return new URL(raw).origin;
	} catch {
		return DEV_ORIGIN;
	}
}

/**
 * True for an origin that only resolves on the machine that rendered it.
 *
 * `0.0.0.0` is the specific trap here: it is a legal bind address and an
 * illegal destination, so it passes `new URL()` and fails for every reader.
 */
export function isLoopbackOrigin(origin: string): boolean {
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return true;
	}
	return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

export const SITE_ORIGIN = readConfiguredOrigin();

/**
 * An unset or loopback origin in production means every share card previews
 * blank and every feed id is unresolvable -- silently, indefinitely, and with
 * nothing in the logs. It is not worth refusing to boot over, because the site
 * still serves readers correctly, so say it once at startup instead.
 *
 * Silent during `next build`: the build runs in a developer's shell, which has
 * no reason to carry the service's environment, and warning there trains the
 * reader to ignore the message that matters.
 */
const IS_BUILD = process.env["NEXT_PHASE"] === "phase-production-build";
if (process.env.NODE_ENV === "production" && !IS_BUILD && isLoopbackOrigin(SITE_ORIGIN)) {
	console.warn(
		`[signalforge] SIGNALFORGE_SITE_URL resolves to ${SITE_ORIGIN}, which is not reachable ` +
			"from outside this machine. Share cards, feed ids and sitemap URLs will not resolve " +
			"for readers. Set it to the public origin, e.g. https://signal.meowcoder.com",
	);
}

/** An absolute URL for a site-relative path. `path` must start with "/". */
export function absoluteUrl(path: string): string {
	return `${SITE_ORIGIN}${path}`;
}
