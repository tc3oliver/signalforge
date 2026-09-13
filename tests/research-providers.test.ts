import { describe, expect, it, vi } from "vitest";
import { createTavilyProvider } from "../src/research/providers/tavily.ts";
import { createExaProvider } from "../src/research/providers/exa.ts";
import { toCollectedItem } from "../src/research/types.ts";
import type { SecretResolver } from "../src/research/types.ts";

function secrets(map: Record<string, string>): SecretResolver {
	return {
		hasSecret: async (name) => name in map,
		secret: async (name) => {
			const v = map[name];
			if (!v) throw new Error(`no secret: ${name}`);
			return v;
		},
	};
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("tavily provider", () => {
	it("returns results on success and never leaks the api key", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string>)["authorization"];
			expect(auth).toBe("Bearer secret-tavily-key");
			return jsonResponse(200, {
				results: [{ title: "Fed holds rates", url: "https://example.com/fed", content: "summary text", published_date: "2026-09-12" }],
			});
		});
		const provider = createTavilyProvider(fetchMock as unknown as typeof fetch, secrets({ TAVILY_API_KEY: "secret-tavily-key" }));

		const results = await provider.search("fed rate decision", { maxResults: 5 });
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ provider: "tavily", title: "Fed holds rates", url: "https://example.com/fed" });
		expect(results[0]?.retrievedAt).toBeTruthy();

		const item = toCollectedItem(results[0]!);
		expect(item.sourceType).toBe("web");
		expect(item.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
		expect(item.metadata["query"]).toBe("fed rate decision");
		expect(item.raw.body).toEqual(results[0]!.raw);

		// The request itself must carry the key (it's how auth to the real API
		// works), but nothing returned to the caller — the parsed results, the
		// converted item, or any error text — may ever surface it.
		expect(JSON.stringify(results)).not.toContain("secret-tavily-key");
		expect(JSON.stringify(item)).not.toContain("secret-tavily-key");
	});

	it("throws a credential error when the secret is missing, without ever calling fetch or leaking any secret material", async () => {
		const fetchMock = vi.fn();
		const provider = createTavilyProvider(fetchMock as unknown as typeof fetch, secrets({}));
		let caught: unknown;
		try {
			await provider.search("q", {});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/unauthorized/i);
		expect((caught as Error).message).not.toContain("TAVILY_API_KEY_VALUE");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("throws a response error on malformed JSON", async () => {
		const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
		const provider = createTavilyProvider(fetchMock as unknown as typeof fetch, secrets({ TAVILY_API_KEY: "k" }));
		await expect(provider.search("q", {})).rejects.toThrow(/malformed/i);
	});
});

describe("exa provider", () => {
	it("returns results on success", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("secret-exa-key");
			return jsonResponse(200, {
				results: [{ title: "Exa result", url: "https://example.com/exa", text: "exa summary" }],
			});
		});
		const provider = createExaProvider(fetchMock as unknown as typeof fetch, secrets({ EXA_API_KEY: "secret-exa-key" }));
		const results = await provider.search("q", {});
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ provider: "exa", title: "Exa result" });
	});
});
