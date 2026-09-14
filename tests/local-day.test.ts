import { describe, expect, it } from "vitest";
import {
	assertZone,
	localDateKey,
	localDayWindow,
	reportingZone,
	shiftDateKey,
	startOfLocalDay,
	zoneOffsetMs,
} from "../src/runtime/local-day.ts";

/*
 * These pin the boundary that decides which day a run belongs to. Getting it
 * wrong is not a rounding error: it stamps the brief with the wrong date and
 * closes the collection window in the middle of the day it claims to cover.
 */

const TAIPEI = "Asia/Taipei";

describe("reporting zone", () => {
	it("prefers the configured zone over the machine's", () => {
		expect(reportingZone({ DI_TIMEZONE: TAIPEI } as NodeJS.ProcessEnv)).toBe(TAIPEI);
	});

	it("ignores a blank setting", () => {
		expect(reportingZone({ DI_TIMEZONE: "   " } as NodeJS.ProcessEnv)).not.toBe("   ");
	});

	it("rejects a zone Intl cannot load rather than quietly using UTC", () => {
		expect(() => assertZone("Mars/Olympus")).toThrow(/Unknown time zone/);
		expect(() => assertZone(TAIPEI)).not.toThrow();
	});
});

describe("local date key", () => {
	it("names the day the reader is living in, not the UTC one", () => {
		// 05:30 in Taipei on the 14th is 21:30 UTC on the 13th: the exact case
		// that made every scheduled run report yesterday's date.
		const at = new Date("2026-09-13T21:30:00.000Z");
		expect(at.toISOString().slice(0, 10)).toBe("2026-09-13");
		expect(localDateKey(at, TAIPEI)).toBe("2026-09-14");
	});

	it("agrees with UTC for a zone at zero offset", () => {
		const at = new Date("2026-09-13T21:30:00.000Z");
		expect(localDateKey(at, "UTC")).toBe("2026-09-13");
	});

	it("handles a zone behind Greenwich", () => {
		// 20:00 UTC is still the previous afternoon in Los Angeles.
		expect(localDateKey(new Date("2026-09-14T02:00:00.000Z"), "America/Los_Angeles")).toBe(
			"2026-09-13",
		);
	});
});

describe("zone offset", () => {
	it("is positive east of Greenwich", () => {
		expect(zoneOffsetMs(new Date("2026-09-13T00:00:00.000Z"), TAIPEI)).toBe(8 * 3600_000);
	});

	it("tracks a daylight-saving change", () => {
		const winter = zoneOffsetMs(new Date("2026-01-15T12:00:00.000Z"), "Europe/London");
		const summer = zoneOffsetMs(new Date("2026-07-15T12:00:00.000Z"), "Europe/London");
		expect(winter).toBe(0);
		expect(summer).toBe(3600_000);
	});
});

describe("local day window", () => {
	it("starts a Taipei day at 16:00 UTC the previous day", () => {
		const window = localDayWindow("2026-09-14", TAIPEI);
		expect(window.from.toISOString()).toBe("2026-09-13T16:00:00.000Z");
		expect(window.to.toISOString()).toBe("2026-09-14T16:00:00.000Z");
	});

	it("is exactly the UTC calendar day for UTC", () => {
		const window = localDayWindow("2026-09-14", "UTC");
		expect(window.from.toISOString()).toBe("2026-09-14T00:00:00.000Z");
		expect(window.to.toISOString()).toBe("2026-09-15T00:00:00.000Z");
	});

	it("contains the instant the run fires and the whole local day", () => {
		const window = localDayWindow("2026-09-14", TAIPEI);
		const runFiredAt = new Date("2026-09-13T21:30:00.000Z"); // 05:30 local
		expect(runFiredAt >= window.from && runFiredAt < window.to).toBe(true);
	});

	it("keeps a spring-forward day one day long, not 24 hours", () => {
		// London loses an hour on 2026-03-29, so that local day is 23 hours.
		const window = localDayWindow("2026-03-29", "Europe/London");
		expect(window.to.getTime() - window.from.getTime()).toBe(23 * 3600_000);
		expect(startOfLocalDay("2026-03-30", "Europe/London").toISOString()).toBe(
			"2026-03-29T23:00:00.000Z",
		);
	});

	it("rejects a malformed date key", () => {
		expect(() => localDayWindow("14-09-2026", TAIPEI)).toThrow(/expected YYYY-MM-DD/);
		expect(() => startOfLocalDay("nonsense", TAIPEI)).toThrow(/expected YYYY-MM-DD/);
	});
});

describe("date key arithmetic", () => {
	it("shifts across a month boundary", () => {
		expect(shiftDateKey("2026-09-30", 1)).toBe("2026-10-01");
		expect(shiftDateKey("2026-01-01", -1)).toBe("2025-12-31");
	});
});
