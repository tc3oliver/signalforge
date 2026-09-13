import { describe, expect, it, vi } from "vitest";
import { ResearchBudgetTracker, ResearchRouter } from "../src/research/router.ts";
import type { ResearchBudgets, ResearchProvider, ResearchResult } from "../src/research/types.ts";
import { ProviderCredentialError, ProviderResponseError } from "../src/research/types.ts";

const budgets: ResearchBudgets = {
	maxQueryLength: 200,
	maxResults: 10,
	perRequestTimeoutMs: 5_000,
	maxCallsPerStory: 3,
	maxCallsPerRun: 100,
};

function fakeProvider(name: "tavily" | "exa", impl: (query: string) => Promise<ResearchResult[]>): ResearchProvider {
	return {
		name,
		check: async () => ({ ok: true, detail: "ok" }),
		search: impl,
	};
}

function oneResult(provider: "tavily" | "exa"): ResearchResult[] {
	return [
		{
			provider,
			query: "q",
			title: "t",
			url: "https://example.com",
			snippet: "s",
			retrievedAt: new Date().toISOString(),
			raw: { provider },
		},
	];
}

describe("ResearchRouter", () => {
	it("uses tavily when it succeeds, not degraded", async () => {
		const tavily = fakeProvider("tavily", async () => oneResult("tavily"));
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.providerUsed).toBe("tavily");
			expect(outcome.degraded).toBe(false);
		}
	});

	it("falls back to exa on tavily credential failure and marks DEGRADED with a distinguishable reason", async () => {
		const tavily = fakeProvider("tavily", async () => {
			throw new ProviderCredentialError("tavily");
		});
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.providerUsed).toBe("exa");
			expect(outcome.degraded).toBe(true);
			expect(outcome.degradedReason).toBe("TAVILY_CREDENTIAL_MISSING");
			const tavilyAttempt = outcome.attempts.find((a) => a.provider === "tavily");
			expect(tavilyAttempt?.failureClass).toBe("AUTH");
			expect(tavilyAttempt?.reason).toBe("credential_missing");
		}
	});

	it("falls back to exa on tavily 401 http failure, distinct reason from credential-missing", async () => {
		const httpAuthErr = Object.assign(new Error("unauthorized"), { status: 401 });
		const tavily = fakeProvider("tavily", async () => {
			throw httpAuthErr;
		});
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.degraded).toBe(true);
			expect(outcome.degradedReason).toBe("TAVILY_AUTH_FAILED");
			expect(outcome.attempts[0]?.reason).not.toBe("credential_missing");
		}
	});

	it("falls back to exa on rate limit (429)", async () => {
		const rateLimitErr = Object.assign(new Error("request failed with status 429"), { status: 429 });
		const tavily = fakeProvider("tavily", async () => {
			throw rateLimitErr;
		});
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.degradedReason).toBe("TAVILY_RATE_LIMITED");
			expect(outcome.attempts[0]?.failureClass).toBe("RATE_LIMIT");
		}
	});

	it("falls back to exa on timeout", async () => {
		const timeoutErr = new DOMException("Timeout", "TimeoutError");
		const tavily = fakeProvider("tavily", async () => {
			throw timeoutErr;
		});
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.degradedReason).toBe("TAVILY_TIMEOUT");
			expect(outcome.attempts[0]?.failureClass).toBe("TIMEOUT");
		}
	});

	it("falls back to exa on malformed tavily JSON", async () => {
		const tavily = fakeProvider("tavily", async () => {
			throw new ProviderResponseError("tavily", "bad json");
		});
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("OK");
		if (outcome.status === "OK") {
			expect(outcome.degradedReason).toBe("TAVILY_MALFORMED_RESPONSE");
		}
	});

	it("returns empty with a degraded reason and never throws when both providers are down", async () => {
		const tavily = fakeProvider("tavily", async () => {
			throw new Error("network down");
		});
		const exa = fakeProvider("exa", async () => {
			throw new Error("network down");
		});
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		const outcome = await router.search("q", "story-1");
		expect(outcome.status).toBe("DEGRADED_EMPTY");
		if (outcome.status === "DEGRADED_EMPTY") {
			expect(outcome.degradedReason).toBe("BOTH_UNAVAILABLE");
			expect(outcome.attempts).toHaveLength(2);
		}
	});

	it("refuses an over-long query without throwing or calling any provider", async () => {
		const tavily = fakeProvider("tavily", vi.fn(async () => oneResult("tavily")));
		const exa = fakeProvider("exa", vi.fn(async () => oneResult("exa")));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker({ ...budgets, maxQueryLength: 5 }));

		const outcome = await router.search("a very long query", "story-1");
		expect(outcome.status).toBe("REFUSED");
		if (outcome.status === "REFUSED") expect(outcome.reason).toBe("QUERY_TOO_LONG");
		expect(tavily.search).not.toHaveBeenCalled();
	});

	it("refuses too many requested results", async () => {
		const tavily = fakeProvider("tavily", async () => oneResult("tavily"));
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker({ ...budgets, maxResults: 2 }));

		const outcome = await router.search("q", "story-1", { maxResults: 50 });
		expect(outcome.status).toBe("REFUSED");
		if (outcome.status === "REFUSED") expect(outcome.reason).toBe("TOO_MANY_RESULTS_REQUESTED");
	});

	it("refuses once a story's call budget is exhausted", async () => {
		const tavily = fakeProvider("tavily", async () => oneResult("tavily"));
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker({ ...budgets, maxCallsPerStory: 1 }));

		const first = await router.search("q", "story-1");
		expect(first.status).toBe("OK");
		const second = await router.search("q", "story-1");
		expect(second.status).toBe("REFUSED");
		if (second.status === "REFUSED") expect(second.reason).toBe("STORY_CALL_BUDGET_EXCEEDED");

		// A different story still has its own budget.
		const otherStory = await router.search("q", "story-2");
		expect(otherStory.status).toBe("OK");
	});

	it("refuses once the run's total call budget is exhausted", async () => {
		const tavily = fakeProvider("tavily", async () => oneResult("tavily"));
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker({ ...budgets, maxCallsPerStory: 100, maxCallsPerRun: 1 }));

		const first = await router.search("q", "story-1");
		expect(first.status).toBe("OK");
		const second = await router.search("q", "story-2");
		expect(second.status).toBe("REFUSED");
		if (second.status === "REFUSED") expect(second.reason).toBe("RUN_CALL_BUDGET_EXCEEDED");
	});

	it("never retries a 401/403 against tavily as if transient (single attempt, immediate fallback)", async () => {
		const tavilySearch = vi.fn(async () => {
			throw Object.assign(new Error("forbidden"), { status: 403 });
		});
		const tavily = fakeProvider("tavily", tavilySearch);
		const exa = fakeProvider("exa", async () => oneResult("exa"));
		const router = new ResearchRouter(tavily, exa, new ResearchBudgetTracker(budgets));

		await router.search("q", "story-1");
		expect(tavilySearch).toHaveBeenCalledTimes(1);
	});
});
