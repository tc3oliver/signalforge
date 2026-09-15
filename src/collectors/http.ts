/**
 * Dependency-free fetch wrapper shared by every collector. It owns the
 * cross-cutting network concerns (timeout, retry/backoff, a request budget,
 * and a per-collector rate limiter) so individual collectors only deal with
 * endpoint shapes and normalization.
 */

export interface RetryOptions {
	/** Maximum attempts including the first, e.g. 3 means up to 2 retries. */
	maxAttempts?: number;
	/** Base delay for exponential backoff, in ms. */
	baseDelayMs?: number;
	/** Ceiling on any single backoff delay, in ms. */
	maxDelayMs?: number;
}

export interface TokenBucketOptions {
	/** Bucket capacity, i.e. max burst size. */
	capacity: number;
	/** Tokens refilled per second. */
	refillPerSecond: number;
}

/**
 * Simple token bucket rate limiter. `take()` resolves once a token is
 * available, sleeping as needed — it never rejects, since a collector's
 * timeout/AbortSignal is the thing that should end the wait.
 */
export class TokenBucket {
	#capacity: number;
	#tokens: number;
	#refillPerSecond: number;
	#lastRefill: number;
	#now: () => number;

	constructor(opts: TokenBucketOptions, now: () => number = Date.now) {
		this.#capacity = opts.capacity;
		this.#tokens = opts.capacity;
		this.#refillPerSecond = opts.refillPerSecond;
		this.#now = now;
		this.#lastRefill = now();
	}

	#refill(): void {
		const t = this.#now();
		const elapsedSec = Math.max(0, (t - this.#lastRefill) / 1000);
		if (elapsedSec <= 0) return;
		this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSec * this.#refillPerSecond);
		this.#lastRefill = t;
	}

	async take(signal?: AbortSignal): Promise<void> {
		for (;;) {
			this.#refill();
			if (this.#tokens >= 1) {
				this.#tokens -= 1;
				return;
			}
			const deficitSec = (1 - this.#tokens) / this.#refillPerSecond;
			const waitMs = Math.max(1, Math.ceil(deficitSec * 1000));
			await sleep(waitMs, signal);
		}
	}
}

/** Bounded per-run request counter so a runaway collector cannot hammer an API. */
export class RequestBudget {
	#remaining: number;
	constructor(max: number) {
		this.#remaining = max;
	}
	get remaining(): number {
		return this.#remaining;
	}
	/** Throws once the budget is exhausted; callers should stop collecting, not retry. */
	consume(): void {
		if (this.#remaining <= 0) {
			throw new BudgetExhaustedError("request budget exhausted for this collection run");
		}
		this.#remaining -= 1;
	}
}

export class BudgetExhaustedError extends Error {
	override readonly name = "BudgetExhaustedError";
}

export class HttpError extends Error {
	override readonly name = "HttpError";
	readonly status: number;
	readonly retryAfterMs?: number;
	constructor(message: string, status: number, retryAfterMs?: number) {
		super(message);
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Parse a Retry-After header (seconds, or an HTTP-date) into a delay in ms. */
function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const asSeconds = Number(value);
	if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
	const asDate = Date.parse(value);
	if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
	return undefined;
}

function jitter(ms: number): number {
	// Full jitter: uniform in [0, ms). Avoids synchronized retry storms across collectors.
	return Math.random() * ms;
}

export interface FetchWithRetryOptions extends RetryOptions {
	fetchImpl: typeof globalThis.fetch;
	/** Per-attempt timeout, in ms. */
	timeoutMs?: number;
	signal?: AbortSignal;
	budget?: RequestBudget;
	bucket?: TokenBucket;
}

/**
 * Fetch with timeout, bounded retry, and rate limiting. Retries transport
 * errors, 5xx, and 429 (honouring Retry-After); never retries any other 4xx,
 * since those indicate a request the caller must fix, not a transient
 * condition.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	opts: FetchWithRetryOptions,
): Promise<Response> {
	const maxAttempts = opts.maxAttempts ?? 3;
	const baseDelayMs = opts.baseDelayMs ?? 250;
	const maxDelayMs = opts.maxDelayMs ?? 10_000;
	const timeoutMs = opts.timeoutMs ?? 15_000;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		opts.signal?.throwIfAborted();
		opts.budget?.consume();
		await opts.bucket?.take(opts.signal);

		const timeoutController = new AbortController();
		const onOuterAbort = () => timeoutController.abort(opts.signal?.reason);
		opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
		const timer = setTimeout(() => timeoutController.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);

		try {
			const res = await opts.fetchImpl(url, { ...init, signal: timeoutController.signal });
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onOuterAbort);

			if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
				const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
				if (attempt >= maxAttempts) {
					throw new HttpError(`request failed with status ${res.status}`, res.status, retryAfterMs);
				}
				const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
				await sleep(retryAfterMs ?? jitter(backoff), opts.signal);
				continue;
			}
			if (!res.ok) {
				// Any other 4xx is not retried — it reflects a request the caller must fix.
				throw new HttpError(`request failed with status ${res.status}`, res.status);
			}
			return res;
		} catch (err) {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onOuterAbort);
			if (err instanceof HttpError) throw err;
			lastErr = err;
			if (opts.signal?.aborted) throw err;
			if (attempt >= maxAttempts) throw err;
			const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
			await sleep(jitter(backoff), opts.signal);
		}
	}
	throw lastErr ?? new Error("fetchWithRetry exhausted attempts");
}

/** Run async tasks with a bounded number in flight at once, preserving input order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i] as T, i);
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * How many independent per-entry fetches a collector runs at once (one repo,
 * subreddit, channel, company or series each). Kept small: every collector still
 * has its own TokenBucket, so this only decides how much of a bucket's allowance
 * can be spent in parallel, never how fast the remote is hit.
 */
export const COLLECTOR_CONCURRENCY = 4;
