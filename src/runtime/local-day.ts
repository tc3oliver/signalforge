/*
 * The product thinks in one place's time, because one person reads it there.
 *
 * A UTC calendar day is the wrong unit for a morning briefing: in Asia/Taipei
 * the 05:30 run fires at 21:30 UTC the day before, so a UTC-keyed run is always
 * stamped with yesterday's date and stops collecting two and a half hours
 * before its own window closes. Keying on the reader's local day removes both
 * surprises; the manifest's catch-up sweep is what then carries the previous
 * evening's items into the morning that reports them.
 *
 * The zone is resolved once, explicitly, because a LaunchAgent and an
 * interactive shell do not agree about TZ: set DI_TIMEZONE in the plist rather
 * than trusting whatever launchd inherited.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** IANA zone used for every date key and day boundary. */
export function reportingZone(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env["DI_TIMEZONE"]?.trim();
	if (configured) return configured;
	// Intl is the only zone database available without a dependency. In a
	// stripped environment it can report undefined; UTC is the honest fallback.
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Throws on a zone Intl cannot load, where silently using UTC would misdate a run. */
export function assertZone(zone: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
	} catch {
		throw new Error(`Unknown time zone "${zone}". Set DI_TIMEZONE to an IANA name such as Asia/Taipei.`);
	}
}

const PARTS = Object.freeze({
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
} as const);

/** The wall-clock reading in `zone` at `at`, expressed as if it were UTC. */
function wallClockAsUtc(at: Date, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...PARTS }).formatToParts(at);
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
	// "24" is how some locales render midnight; Date.UTC normalises it anyway.
	return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** Offset of `zone` from UTC at `at`, in milliseconds. East of Greenwich is positive. */
export function zoneOffsetMs(at: Date, zone: string): number {
	return wallClockAsUtc(at, zone) - at.getTime();
}

/** The calendar date in `zone` at `at`, as "YYYY-MM-DD". */
export function localDateKey(at: Date, zone: string): string {
	return new Date(wallClockAsUtc(at, zone)).toISOString().slice(0, 10);
}

/**
 * The instant at which `dateKey` begins in `zone`.
 *
 * Resolved in two passes because the offset depends on the very instant being
 * computed: the first pass guesses with the offset in force at the naive time,
 * the second corrects it when a DST transition sits between the two. Taipei
 * never shifts, but a zone that does must not silently produce an hour-wrong
 * window.
 */
export function startOfLocalDay(dateKey: string, zone: string): Date {
	if (!DATE_KEY.test(dateKey)) throw new Error(`Invalid date "${dateKey}"; expected YYYY-MM-DD`);
	const naive = Date.parse(`${dateKey}T00:00:00.000Z`);
	if (Number.isNaN(naive)) throw new Error(`Invalid date "${dateKey}"; expected YYYY-MM-DD`);
	const first = naive - zoneOffsetMs(new Date(naive), zone);
	const second = naive - zoneOffsetMs(new Date(first), zone);
	return new Date(second);
}

/** Calendar arithmetic on a date key, independent of any zone. */
export function shiftDateKey(dateKey: string, days: number): string {
	if (!DATE_KEY.test(dateKey)) throw new Error(`Invalid date "${dateKey}"; expected YYYY-MM-DD`);
	const shifted = new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + days * 86_400_000);
	return shifted.toISOString().slice(0, 10);
}

export interface LocalDayWindow {
	/** Inclusive lower bound, in UTC. */
	from: Date;
	/** Exclusive upper bound, in UTC. */
	to: Date;
}

/**
 * The UTC bounds of one local calendar day. A day is bounded by the start of
 * the next one rather than by adding 24 hours, so a DST day of 23 or 25 hours
 * is still exactly one day.
 */
export function localDayWindow(dateKey: string, zone: string): LocalDayWindow {
	return {
		from: startOfLocalDay(dateKey, zone),
		to: startOfLocalDay(shiftDateKey(dateKey, 1), zone),
	};
}
