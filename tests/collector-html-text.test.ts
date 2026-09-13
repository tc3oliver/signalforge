import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, htmlToText } from "../src/collectors/html-text.ts";

describe("decodeHtmlEntities", () => {
	it("decodes the numeric entities Hacker News actually emits", () => {
		// Straight from a stored row: every slash and apostrophe arrived encoded.
		expect(decodeHtmlEntities("17–19 GB&#x2F;s")).toBe("17–19 GB/s");
		expect(decodeHtmlEntities("engine&#x27;s prefetch")).toBe("engine's prefetch");
		expect(decodeHtmlEntities("&#65;&#66;")).toBe("AB");
	});

	it("decodes the handful of named entities that appear in practice", () => {
		expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe(`a & b <c> "d"`);
	});

	it("leaves anything it does not recognise exactly as written", () => {
		// Mangling an unknown entity into a replacement character would hide what
		// the source actually published.
		expect(decodeHtmlEntities("&notarealentity; &#x110000; &#0;")).toBe(
			"&notarealentity; &#x110000; &#0;",
		);
	});
});

describe("htmlToText", () => {
	it("turns paragraphs and breaks into newlines", () => {
		expect(htmlToText("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
		expect(htmlToText("a<br>b<br />c")).toBe("a\nb\nc");
	});

	it("keeps a link's destination instead of burying it in an attribute", () => {
		expect(htmlToText('<a href="https://example.test/x">the write-up</a>')).toBe(
			"the write-up (https://example.test/x)",
		);
	});

	it("collapses a bare link whose label is the truncated url", () => {
		// The commonest Hacker News shape: a link-only submission rendered as an
		// anchor whose visible text is the same url, shortened with an ellipsis.
		const html =
			'<a href="https:&#x2F;&#x2F;archive.ph&#x2F;1xTJ3" rel="nofollow">https:&#x2F;&#x2F;archive.ph&#x2F;1xTJ3</a>';
		expect(htmlToText(html)).toBe("https://archive.ph/1xTJ3");

		const truncated =
			'<a href="https://mullvad.net/en/blog/another-way" rel="nofollow">https://mullvad.net/en/blog/anoth...</a>';
		expect(htmlToText(truncated)).toBe("https://mullvad.net/en/blog/another-way");
	});

	it("produces plain text from a real stored summary", () => {
		const stored =
			"RTL performance erratum throttles throughput to 17–19 GB&#x2F;s from 45–60 GB&#x2F;s. " +
			"Avoiding the DMA engine&#x27;s prefetch ring raised throughput to 24.3 tokens&#x2F;s.";
		expect(htmlToText(stored)).toBe(
			"RTL performance erratum throttles throughput to 17–19 GB/s from 45–60 GB/s. " +
				"Avoiding the DMA engine's prefetch ring raised throughput to 24.3 tokens/s.",
		);
		expect(htmlToText(stored)).not.toContain("&#");
	});

	it("does not let markup hide text from the agent", () => {
		// Whatever a source wraps its words in, the words still arrive.
		expect(htmlToText("<i>emphasis</i> and <code>literal</code>")).toBe("emphasis and literal");
		expect(htmlToText('<span title="hidden">visible</span>')).toBe("visible");
	});

	it("is a no-op on text that was never HTML", () => {
		expect(htmlToText("plain sentence, 5 > 3 is true")).toBe("plain sentence, 5 > 3 is true");
		expect(htmlToText("")).toBe("");
	});
});
