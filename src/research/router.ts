import { classifyError } from "../runtime/error-classifier.ts";
import { ProviderCredentialError, ProviderResponseError } from "./types.ts";
import type { DegradedReason, ProviderAttempt, ResearchBudgets, ResearchOutcome, ResearchProvider, ResearchSearchOptions } from "./types.ts";

/**
 * Per-run call accounting shared across every `search()` call the caller
 * makes through one router instance. Budgets are enforced with a clean
 * refusal (see ResearchOutcome "REFUSED"), never an exception and never a
 * silent truncation.
 */
export class ResearchBudgetTracker {
	#budgets: ResearchBudgets;
	#runCalls = 0;
	#storyCalls = new Map<string, number>();

	constructor(budgets: ResearchBudgets) {
		this.#budgets = budgets;
	}

	checkQuery(query: string, maxResults: number | undefined): ResearchOutcome | undefined {
		if (query.length > this.#budgets.maxQueryLength) {
			return {
				status: "REFUSED",
				reason: "QUERY_TOO_LONG",
				message: `query length ${query.length} exceeds budget of ${this.#budgets.maxQueryLength} characters`,
			};
		}
		if (maxResults !== undefined && maxResults > this.#budgets.maxResults) {
			return {
				status: "REFUSED",
				reason: "TOO_MANY_RESULTS_REQUESTED",
				message: `requested ${maxResults} results exceeds budget of ${this.#budgets.maxResults}`,
			};
		}
		return undefined;
	}

	checkCallBudget(storyId: string): ResearchOutcome | undefined {
		const storyCalls = this.#storyCalls.get(storyId) ?? 0;
		if (storyCalls >= this.#budgets.maxCallsPerStory) {
			return {
				status: "REFUSED",
				reason: "STORY_CALL_BUDGET_EXCEEDED",
				message: `story "${storyId}" has already used its budget of ${this.#budgets.maxCallsPerStory} research calls`,
			};
		}
		if (this.#runCalls >= this.#budgets.maxCallsPerRun) {
			return {
				status: "REFUSED",
				reason: "RUN_CALL_BUDGET_EXCEEDED",
				message: `this run has already used its budget of ${this.#budgets.maxCallsPerRun} research calls`,
			};
		}
		return undefined;
	}

	/** Records one provider call attempt (primary + fallback both count) against the story/run budget. */
	recordCall(storyId: string): void {
		this.#runCalls += 1;
		this.#storyCalls.set(storyId, (this.#storyCalls.get(storyId) ?? 0) + 1);
	}

	get timeoutMs(): number {
		return this.#budgets.perRequestTimeoutMs;
	}
}

function degradedReasonFor(reason: string, failureClassIsAuth: boolean): DegradedReason {
	if (reason === "credential_missing") return "TAVILY_CREDENTIAL_MISSING";
	if (failureClassIsAuth) return "TAVILY_AUTH_FAILED";
	if (reason === "rate_limited") return "TAVILY_RATE_LIMITED";
	if (reason === "timeout") return "TAVILY_TIMEOUT";
	if (reason === "malformed_response") return "TAVILY_MALFORMED_RESPONSE";
	return "TAVILY_UNAVAILABLE";
}

/** Maps a thrown provider error to an admin-safe reason tag, distinct from the generic failureClass bucket. */
function reasonTag(err: unknown): string {
	if (err instanceof ProviderCredentialError) return "credential_missing";
	if (err instanceof ProviderResponseError) return "malformed_response";
	const { failureClass } = classifyError(err);
	switch (failureClass) {
		case "RATE_LIMIT":
			return "rate_limited";
		case "TIMEOUT":
			return "timeout";
		case "AUTH":
			return "http_auth_failed";
		default:
			return "provider_error";
	}
}

/**
 * Routes a search through Tavily first, falling back to Exa on any failure.
 * Never throws for provider-side failures — a research outage degrades the
 * brief, it does not fail the run. Only programmer errors in the budget
 * tracker (e.g. a thrown ResearchBudgets misconfiguration) would surface as
 * exceptions, and none are introduced here.
 */
export class ResearchRouter {
	#tavily: ResearchProvider;
	#exa: ResearchProvider;
	#budgets: ResearchBudgetTracker;

	constructor(tavily: ResearchProvider, exa: ResearchProvider, budgets: ResearchBudgetTracker) {
		this.#tavily = tavily;
		this.#exa = exa;
		this.#budgets = budgets;
	}

	async search(query: string, storyId: string, opts: ResearchSearchOptions = {}): Promise<ResearchOutcome> {
		const queryRefusal = this.#budgets.checkQuery(query, opts.maxResults);
		if (queryRefusal) return queryRefusal;

		const budgetRefusal = this.#budgets.checkCallBudget(storyId);
		if (budgetRefusal) return budgetRefusal;

		const searchOpts: ResearchSearchOptions = {
			...opts,
			timeoutMs: opts.timeoutMs ?? this.#budgets.timeoutMs,
		};

		const attempts: ProviderAttempt[] = [];
		const startTavily = Date.now();
		this.#budgets.recordCall(storyId);
		try {
			const results = await this.#tavily.search(query, searchOpts);
			attempts.push({ provider: "tavily", outcome: "SUCCESS", durationMs: Date.now() - startTavily });
			return { status: "OK", results, degraded: false, providerUsed: "tavily", attempts };
		} catch (tavilyErr) {
			const { failureClass } = classifyError(tavilyErr);
			const reason = reasonTag(tavilyErr);
			attempts.push({
				provider: "tavily",
				outcome: "FAILURE",
				failureClass,
				reason,
				durationMs: Date.now() - startTavily,
			});

			// A hard 401/403 (real credential rejection, not just a missing local
			// secret) is never retried against Tavily as if it were transient —
			// it goes straight to fallback, same as every other failure here.
			const degradedReason = degradedReasonFor(reason, failureClass === "AUTH");

			const secondCallBudgetRefusal = this.#budgets.checkCallBudget(storyId);
			if (secondCallBudgetRefusal) {
				// Budget was consumed by the Tavily attempt itself; report the
				// exhaustion rather than silently returning nothing.
				return secondCallBudgetRefusal;
			}

			const startExa = Date.now();
			this.#budgets.recordCall(storyId);
			try {
				const results = await this.#exa.search(query, searchOpts);
				attempts.push({ provider: "exa", outcome: "SUCCESS", durationMs: Date.now() - startExa });
				return {
					status: "OK",
					results,
					degraded: true,
					degradedReason,
					providerUsed: "exa",
					attempts,
				};
			} catch (exaErr) {
				const { failureClass: exaFailureClass } = classifyError(exaErr);
				const exaReason = reasonTag(exaErr);
				attempts.push({
					provider: "exa",
					outcome: "FAILURE",
					failureClass: exaFailureClass,
					reason: exaReason,
					durationMs: Date.now() - startExa,
				});
				return { status: "DEGRADED_EMPTY", degradedReason: "BOTH_UNAVAILABLE", attempts };
			}
		}
	}
}
