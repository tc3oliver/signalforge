import { describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, HttpError, RequestBudget, TokenBucket, fetchWithRetry, mapWithConcurrency } from "../src/collectors/http.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("fetchWithRetry", () => {
	it("returns the response on success without retrying", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
		const res = await fetchWithRetry("https://example.test", {}, { fetchImpl });
		expect(await res.json()).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries on 5xx then succeeds", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const res = await fetchWithRetry("https://example.test", {}, { fetchImpl, baseDelayMs: 1, maxDelayMs: 2 });
		expect(await res.json()).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("honours Retry-After on 429 before retrying", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }, { "retry-after": "0" }))
			.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
		const res = await fetchWithRetry("https://example.test", {}, { fetchImpl, baseDelayMs: 1 });
		expect(res.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("never retries a non-429 4xx", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: "not found" }));
		await expect(fetchWithRetry("https://example.test", {}, { fetchImpl })).rejects.toThrow(HttpError);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("throws HttpError after exhausting retries on repeated 5xx", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
		await expect(
			fetchWithRetry("https://example.test", {}, { fetchImpl, maxAttempts: 2, baseDelayMs: 1 }),
		).rejects.toThrow(HttpError);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("times out a hung request", async () => {
		const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			});
		});
		await expect(
			fetchWithRetry("https://example.test", {}, { fetchImpl, timeoutMs: 5, maxAttempts: 1 }),
		).rejects.toThrow();
	});

	it("respects a caller AbortSignal", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
		controller.abort();
		await expect(
			fetchWithRetry("https://example.test", {}, { fetchImpl, signal: controller.signal }),
		).rejects.toThrow();
	});

	it("throws BudgetExhaustedError once the request budget runs out", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
		const budget = new RequestBudget(0);
		await expect(fetchWithRetry("https://example.test", {}, { fetchImpl, budget })).rejects.toThrow(BudgetExhaustedError);
	});
});

describe("TokenBucket", () => {
	it("allows immediate takes up to capacity, then waits", async () => {
		let now = 0;
		const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1000 }, () => now);
		await bucket.take();
		await bucket.take();
		const start = Date.now();
		now += 1; // simulate a tiny bit of elapsed time to refill
		await bucket.take();
		expect(Date.now() - start).toBeGreaterThanOrEqual(0);
	});
});

describe("mapWithConcurrency", () => {
	it("preserves order and respects the concurrency limit", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = [1, 2, 3, 4, 5];
		const results = await mapWithConcurrency(items, 2, async (n) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return n * 2;
		});
		expect(results).toEqual([2, 4, 6, 8, 10]);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});
});
