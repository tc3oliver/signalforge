import { describe, expect, it } from "vitest";
import { locateQuote, locateQuotes } from "../src/evidence/locate.ts";

/*
 * The safety property these pin: a quotation the Curator is shown is a slice of
 * the source, located by the server, or it does not exist. Measured on the
 * 2026-09-19 items, exact matching over normalized prose relocates 97-99% of
 * proposed spans, while no similarity threshold separates an accurate quote
 * from one with a digit changed.
 */

describe("locateQuote", () => {
	it("returns the source's own characters, not the candidate's", () => {
		const body = "The gateway routes on KV cache utilisation — avoiding full pods.";
		// The model proposes the same sentence with straight punctuation.
		const hit = locateQuote(body, 'The gateway routes on KV cache utilisation - avoiding full pods.');
		expect(hit?.quote).toBe(body);
		expect(hit?.at).toBe(0);
	});

	it("matches across curly quotes, dashes, case and collapsed whitespace", () => {
		const body = "He said\n  “no  more than 30 words” — and meant it.";
		const hit = locateQuote(body, '"NO MORE THAN 30 WORDS"');
		expect(hit).toBeDefined();
		// The marks around the candidate are the model's delimiters, so the span
		// is the passage itself; the body's own spacing is preserved.
		expect(body.slice(hit!.at, hit!.end)).toBe("no  more than 30 words");
	});

	it("reports an offset into the body it was given", () => {
		const body = `${"lead. ".repeat(100)}the decisive fact.`;
		const hit = locateQuote(body, "the decisive fact.");
		expect(hit?.at).toBe(600);
		expect(hit?.quote).toBe("the decisive fact.");
	});

	/*
	 * The failure that must stay a failure. Corrupting one meaning-bearing word
	 * leaves a span scoring above 0.95 on substring coverage, which is why there
	 * is no similarity tier: a genuine model error scored 0.87 on the same
	 * measure, so no threshold separates them.
	 */
	it("refuses a quote whose number was changed", () => {
		const body = "The answer is no more than 30 words.";
		expect(locateQuote(body, "The answer is no more than 50 words.")).toBeUndefined();
	});

	it("refuses a quote whose meaning was negated", () => {
		const body = "My proof has not been independently verified.";
		expect(locateQuote(body, "My proof has been independently verified.")).toBeUndefined();
	});

	it("refuses a plausible sentence that is not in the document", () => {
		const body = "Routing considers queue depth and adapter residency.";
		expect(locateQuote(body, "Routing considers prefix cache hit rate.")).toBeUndefined();
	});

	it("has no answer for an empty candidate or an empty body", () => {
		expect(locateQuote("some text", "   ")).toBeUndefined();
		expect(locateQuote("", "some text")).toBeUndefined();
	});
});

describe("locateQuotes", () => {
	it("keeps what it finds, counts what it drops, and orders by position", () => {
		const body = "Alpha happened. Beta happened. Gamma happened.";
		const { located, dropped } = locateQuotes(body, [
			"Gamma happened.",
			"Delta happened.",
			"Alpha happened.",
		]);
		expect(located.map((l) => l.quote)).toEqual(["Alpha happened.", "Gamma happened."]);
		expect(dropped).toBe(1);
	});

	it("counts one passage once, however many times it was proposed", () => {
		const body = "Alpha happened. Beta happened.";
		const { located, dropped } = locateQuotes(body, ["Alpha happened.", "alpha happened."]);
		expect(located).toHaveLength(1);
		expect(dropped).toBe(0);
	});
});

describe("delimiters the model adds", () => {
	/*
	 * A live check found every passage from one document wrapped in curly quotes
	 * that are not in the source, so the longest matching prefix was the mark
	 * itself and four correct passages were discarded.
	 */
	it("locates a passage the model wrapped in quotation marks", () => {
		const body = "Once both bits were set, they remained set without further pulses.";
		const hit = locateQuote(body, "“Once both bits were set, they remained set without further pulses.”");
		expect(hit?.quote).toBe(body);
		expect(hit?.at).toBe(0);
	});

	it("locates a passage the model cut short with an ellipsis", () => {
		const body = "The demonstrated sequence provides Secure-attributed memory access and more.";
		const hit = locateQuote(body, "The demonstrated sequence provides Secure-attributed memory access…");
		expect(hit?.quote).toBe("The demonstrated sequence provides Secure-attributed memory access");
	});

	it("still refuses a wrapped passage whose contents were changed", () => {
		const body = "Once both bits were set, they remained set.";
		expect(locateQuote(body, "“Once both bits were set, they were cleared.”")).toBeUndefined();
	});
});
