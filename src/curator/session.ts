import type { DailyManifest, DailyMaterials } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";
import type { AgentDriverFactory } from "../runtime/agent-driver.ts";
import type { ModelSpec } from "../runtime/model-config.ts";
import type { TokenUsage } from "../schemas/run.ts";
import { InvalidAgentOutputError, ToolLoopError } from "../runtime/error-classifier.ts";
import { loadProjectSkills } from "../runtime/pi-runtime.ts";
import { isTurnAbandoned, TurnTimeoutError, withTurnTimeout } from "../runtime/turn-timeout.ts";
import {
	DEFAULT_SOFT_DEADLINE_FRACTION,
	ProgressYieldError,
	TurnBudget,
} from "../runtime/progress-yield.ts";
import {
	createSkillReferenceTool,
	loadSkillBundle,
	renderSkillSection,
} from "../runtime/skill-access.ts";
import { measureToolResults } from "../agent-tools/shared.ts";
import { asSilentProviderFailure } from "../runtime/silent-model.ts";
import { createCuratorTools, type CuratorContext } from "./tools.ts";
import { buildWorkUnitBrief, renderWorkUnitBrief } from "./work-unit.ts";
import { renderReaderProfile, type ReaderProfile } from "../profile/reader-profile.ts";
import {
	buildCuratorNudgePrompt,
	buildCuratorResumePrompt,
	buildCuratorSystemPrompt,
	buildCuratorTaskPrompt,
} from "./prompt.ts";

export interface CuratorStageOptions {
	date: string;
	manifest: DailyManifest;
	repo: StoryRepository;
	spec: ModelSpec;
	skillsRoot: string;
	cwd: string;
	driverFactory: AgentDriverFactory;
	/**
	 * The reader's standing interests, as priors on relevance. Optional: a run
	 * without a config gets the prompt it always got, rather than a profile block
	 * asserting the reader cares about nothing.
	 */
	readerProfile?: ReaderProfile;
	/** "FRESH" starts the task from the top; the others carry context into a new session. */
	mode: "FRESH" | "CORRECTIVE" | "RESUME";
	/** Rejection text from a previous attempt, fed back so the retry is informed. */
	lastError?: string;
	now?: () => Date;
	maxNudges?: number;
	/** Bound on a single model turn; see runtime/turn-timeout.ts. */
	timeoutMs?: number;
	/**
	 * Decisions one attempt may record before it yields to a fresh session.
	 *
	 * This is what makes the curator a bounded resumable worker rather than one
	 * turn trying to finish a whole day. Undefined means unbounded, which is what
	 * every eval, gold and fixture run wants: their manifests are small, they
	 * finish in one turn, and a yield would change the shape of their output.
	 *
	 * The budget spans the whole attempt rather than resetting per turn. An
	 * attempt is normally exactly one turn -- the nudge loop only runs when a
	 * model stopped early without spending its budget -- and a budget that reset
	 * on each nudge would let one session record `maxNudges` times the intended
	 * work unit, which is the ceiling it exists to prevent.
	 */
	maxDecisionsPerTurn?: number;
	/**
	 * Items the screener withheld from the default broad scan (routed DROP
	 * verdicts from the trusted screener version). Computed once per run by the
	 * pipeline and passed to every attempt and continuation unchanged, so the
	 * workset cannot shift between sessions. Absent outside route mode.
	 */
	screenedOutItemIds?: ReadonlySet<string>;
	onEvent?: (event: Record<string, unknown>) => void;
	onText?: (delta: string) => void;
	/**
	 * Test-only fault injection checkpoint (see `runtime/fault-injection.ts`).
	 * Throws a synthetic, classifier-real error once the recorded decisions reach
	 * the configured threshold; a no-op when fault injection is off.
	 */
	checkFault?: (processedItems: number) => void;
	/** Receives the driver's provider-reported usage before the driver is disposed. */
	reportUsage?: (usage: TokenUsage) => void;
}

export interface CuratorStageResult {
	materials: DailyMaterials;
	toolCalls: number;
	activeToolNames: string[];
}

/**
 * Drives one curator attempt on one model. Fallback across models happens a level
 * up in runStageWithFallback — this function either produces accepted materials or
 * throws a classified error.
 */
export async function runCuratorStage(opts: CuratorStageOptions): Promise<CuratorStageResult> {
	const now = opts.now ?? (() => new Date());
	const maxNudges = opts.maxNudges ?? 6;

	const skills = loadProjectSkills(opts.skillsRoot);
	const bundle = loadSkillBundle(skills[0]!);

	let toolCalls = 0;
	// An injected failure has to survive being thrown from inside a tool: Pi hands
	// a thrown tool error back to the model as a correctable result, so the first
	// throw is remembered here and re-thrown at every later boundary. The model
	// can then make no further progress, the turn ends, and the attempt fails with
	// the injected error -- exactly as a real provider outage would end it.
	let faultError: Error | undefined;
	/*
	 * The work unit is bounded by a decision count AND by a fraction of the turn
	 * clock. Either alone is wrong at one end of the observed rate spread: the
	 * count runs past the clock when decisions are slow, and leaves most of the
	 * clock unused when they are fast.
	 *
	 * The soft deadline is derived from `timeoutMs` rather than configured beside
	 * it so the two cannot be tuned into disagreement -- a soft deadline longer
	 * than the hard timeout would be a budget that never fires.
	 */
	const turnBudget =
		opts.maxDecisionsPerTurn !== undefined && opts.maxDecisionsPerTurn > 0
			? new TurnBudget(opts.maxDecisionsPerTurn, {
					...(opts.timeoutMs !== undefined && opts.timeoutMs > 0
						? { softDeadlineMs: Math.floor(opts.timeoutMs * DEFAULT_SOFT_DEADLINE_FRACTION) }
						: {}),
				})
			: undefined;
	const ctx: CuratorContext = {
		date: opts.date,
		manifest: opts.manifest,
		repo: opts.repo,
		now,
		...(turnBudget ? { turnBudget } : {}),
		...(opts.screenedOutItemIds ? { screenedOutItemIds: opts.screenedOutItemIds } : {}),
		...(opts.readerProfile
			? { topicIds: new Set(opts.readerProfile.topics.map((t) => t.id)) }
			: {}),
		onToolCall: (name, summary) => {
			toolCalls += 1;
			opts.onEvent?.({ kind: "tool_call", stage: "CURATOR", tool: name, ...summary });
		},
		...(opts.checkFault
			? {
					onToolBoundary: async () => {
						if (faultError) throw faultError;
						try {
							opts.checkFault?.((await opts.repo.processedItemIds(opts.date)).size);
						} catch (err) {
							faultError = err instanceof Error ? err : new Error(String(err));
							throw faultError;
						}
					},
				}
			: {}),
	};

	// A submit_materials rejection reaches the model once, as a tool-error result.
	// Capturing it here is what lets the next nudge — and the eventual failure —
	// say what was actually wrong instead of "you have not submitted yet".
	// `lastError` is cleared once fed back; `lastRejection` is kept for the error.
	let lastError: string | undefined;
	let lastRejection: string | undefined;
	let rejectedSubmissions = 0;

	const curatorTools = createCuratorTools(ctx).map((tool) => {
		if (tool.name !== "submit_materials") return tool;
		const inner = tool.execute.bind(tool);
		return {
			...tool,
			execute: async (...args: Parameters<typeof inner>) => {
				try {
					return await inner(...args);
				} catch (err) {
					rejectedSubmissions += 1;
					lastError = err instanceof Error ? err.message : String(err);
					lastRejection = lastError;
					opts.onEvent?.({ kind: "submit_rejected", stage: "CURATOR", error: lastError });
					throw err;
				}
			},
		};
	});

	/*
	 * Result sizes for every tool, including the skill reference: this is the
	 * context the session accumulates and re-sends on each later turn, and it
	 * is the term the token decomposition could not see.
	 */
	const tools = measureToolResults([...curatorTools, createSkillReferenceTool(bundle)], (info) =>
		opts.onEvent?.({ kind: "tool_result", stage: "CURATOR", ...info }),
	);

	/*
	 * What the Curator is asked to judge: the manifest minus what the screener
	 * withheld. Progress, the yield condition and the prompt all count against
	 * this set, never against the whole manifest -- a routed day would otherwise
	 * never reach "all decided" and the work unit would never finish.
	 */
	const screenedOut = opts.screenedOutItemIds ?? new Set<string>();
	const offeredIds = new Set(opts.manifest.items.map((i) => i.id).filter((id) => !screenedOut.has(id)));
	const systemPrompt = buildCuratorSystemPrompt({
		date: opts.date,
		totalItems: offeredIds.size,
		manifestItems: opts.manifest.items.length,
		skillSection: renderSkillSection(bundle, "CURATOR"),
		...(opts.readerProfile ? { readerProfile: renderReaderProfile(opts.readerProfile) } : {}),
	});

	const driver = await opts.driverFactory({
		spec: opts.spec,
		systemPrompt,
		customTools: tools,
		skillsRoot: opts.skillsRoot,
		cwd: opts.cwd,
		onText: opts.onText,
	});

	try {
		const totalItems = offeredIds.size;
		/*
		 * Decisions for items OFFERED FROM THIS MANIFEST, not decisions for this date.
		 *
		 * The repository is keyed by date and answers with everything decided that
		 * day, which is a larger set than the manifest whenever a run is continuing
		 * a previous one: the 2026-09-16 recovery inherited 1050 decisions and was
		 * handed a 637-item manifest of what was left, so the date-scoped count
		 * read 1150 against a total of 637. Every comparison downstream then went
		 * the wrong way -- `decidedAfter < totalItems` was false from the first
		 * turn, so the work unit never yielded, and the stall check concluded the
		 * scan was complete while items were still unseen.
		 *
		 * It only looks correct on a fresh day, where the manifest is a superset of
		 * the day's decisions. That is exactly the case the tests covered.
		 */
		const decidedCount = async () => {
			const processed = await opts.repo.processedItemIds(opts.date);
			let n = 0;
			for (const id of offeredIds) if (processed.has(id)) n++;
			return n;
		};

		const decidedAtStart = await decidedCount();

		/*
		 * The session opens holding the state it used to spend three turns
		 * fetching: the day's counts, the page it is about to work on, and the
		 * ids of the stories already written. None of those is a judgement, and
		 * asking for each cost a model turn, in every unit, twelve times a day.
		 *
		 * Read once, here, at the point the orchestrator has already decided to
		 * hand this session work -- so the numbers in the prompt and the numbers
		 * the orchestrator started it with are the same read.
		 */
		const brief = await buildWorkUnitBrief({
			date: opts.date,
			manifest: opts.manifest,
			repo: opts.repo,
			screenedOutItemIds: screenedOut,
			...(opts.maxDecisionsPerTurn !== undefined && opts.maxDecisionsPerTurn > 0
				? { decisionBudget: opts.maxDecisionsPerTurn }
				: {}),
		});
		const briefText = renderWorkUnitBrief(brief);

		/*
		 * What the stage itself puts into the session, measured like a tool result.
		 *
		 * `measureToolResults` instruments tools and only tools, so the opening
		 * message has never been counted -- and it used to be two short paragraphs.
		 * Since the work unit is pre-seeded it carries the page, the day's counts
		 * and the ledger's ids: on a real 50-item page that measures about 8,900
		 * tokens, re-sent on every turn of the unit, which makes it the largest
		 * single payload in the stage and it was invisible.
		 *
		 * It also breaks the old cost model. The regression behind the 11,625
		 * tokens-per-turn figure was fitted when the page arrived as a
		 * `list_unseen_items` result, so the page sat inside its amplified-chars
		 * term; it now sits in the prompt, where that term cannot see it. A re-fit
		 * needs this number, so it is recorded by the run that produces it rather
		 * than reconstructed afterwards.
		 */
		const notePrompt = (kind: string, text: string): void => {
			opts.onEvent?.({ kind: "prompt", stage: "CURATOR", prompt: kind, chars: text.length });
		};

		// A resume picks up durable state rather than replaying the day; a half-dead
		// conversation is never migrated to another model.
		const opening =
			opts.mode === "RESUME" && decidedAtStart > 0
				? `${buildCuratorResumePrompt({ date: opts.date })}\n\n${briefText}`
				: opts.mode === "CORRECTIVE" && opts.lastError
					? `${buildCuratorTaskPrompt({
							date: opts.date,
							totalItems,
							manifestItems: opts.manifest.items.length,
							skillSection: "",
						})}\n\n${briefText}\n\nA previous attempt failed with:\n${opts.lastError}\nAvoid repeating that mistake.`
					: `${buildCuratorTaskPrompt({
							date: opts.date,
							totalItems,
							manifestItems: opts.manifest.items.length,
							skillSection: "",
						})}\n\n${briefText}`;


		/*
		 * One turn, under the turn clock, with the two endings that are not
		 * failures folded in.
		 *
		 * A timeout that committed decisions is reported as a yield rather than a
		 * TIMEOUT. That is the safety net rather than the mechanism: the work-unit
		 * ceiling below is what normally ends a turn, cleanly, at a tool boundary.
		 * But a model can spend its whole turn on one very slow page and be killed
		 * by the clock while still having made real progress, and calling that a
		 * provider fault is precisely the misclassification that burned three
		 * models on 2026-09-16.
		 */
		const runTurn = async (prompt: () => Promise<void>): Promise<void> => {
			const decidedBefore = await decidedCount();
			try {
				await withTurnTimeout(driver, "curator", opts.timeoutMs, prompt);
			} catch (err) {
				// Checked first, and never converted to a yield. A turn that made
				// progress and then would not stop is still a runtime failure: the
				// continuation would be a second session writing this same day.
				if (isTurnAbandoned(err)) throw err;
				if (!(err instanceof TurnTimeoutError)) throw err;
				const decidedAfter = await decidedCount();
				if (decidedAfter <= decidedBefore) throw err;
				throw new ProgressYieldError({
					decidedBefore,
					decidedAfter,
					totalItems,
					reason: "TURN_TIMEOUT_WITH_PROGRESS",
				});
			}
			if (faultError) throw faultError;

			// The clean ending: the turn stopped because the tools stopped offering
			// it work. Only a turn that both spent its budget and left items
			// undecided yields -- a turn that finished the day must fall through to
			// submit_materials, and a turn that stopped early without spending its
			// budget is a stall for the nudge loop to deal with.
			const decidedAfter = await decidedCount();
			if (!ctx.submitted && turnBudget?.exhausted && decidedAfter < totalItems) {
				throw new ProgressYieldError({
					decidedBefore,
					decidedAfter,
					totalItems,
					reason: "WORK_UNIT_COMPLETE",
					...(turnBudget.closedBy ? { closedBy: turnBudget.closedBy } : {}),
				});
			}
		};

		notePrompt(opts.mode === "RESUME" ? "resume" : "opening", opening);
		await runTurn(() => driver.prompt(opening));
		opts.checkFault?.(await decidedCount());

		let nudges = 0;
		let lastProgress = -1;
		let stalls = 0;

		while (!ctx.submitted && nudges < maxNudges) {
			const current = await decidedCount();
			if (faultError) throw faultError;
			opts.checkFault?.(current);

			// No new decisions since the last turn means the model is circling rather
			// than working. Two of those is a tool loop, not a slow start.
			//
			// Only while coverage is incomplete, though: once every item has a
			// decision this number is pinned at totalItems by definition, so a model
			// iterating on a rejected payload would look stalled forever. That
			// failure is a submission-shape failure, and the router has to be told
			// so — a resume prompt would send it back to `list_unseen_items` when
			// there is nothing unseen.
			if (current === lastProgress) {
				stalls += 1;
				if (stalls >= 2) {
					if (current < totalItems) {
						throw new ToolLoopError(
							`Curator made no progress across ${stalls + 1} turns at ${current}/${totalItems} items decided`,
						);
					}
					throw new InvalidAgentOutputError(
						`Curator scanned all ${totalItems} items but did not produce accepted materials across ${stalls + 1} turns (${rejectedSubmissions} rejected submissions)` +
							(lastRejection
								? `. Last rejection: ${lastRejection}`
								: ". It never called submit_materials."),
					);
				}
			} else {
				stalls = 0;
			}
			lastProgress = current;

			nudges += 1;
			opts.onEvent?.({
				kind: "nudge",
				stage: "CURATOR",
				attempt: nudges,
				processed: current,
				total: totalItems,
			});

			// Consumed before the turn: the submit_materials wrapper sets `lastError`
			// from inside it, so clearing afterwards would erase a rejection raised
			// during this nudge before the next prompt could carry it.
			const feedback = lastError;
			lastError = undefined;
			/*
			 * A nudge re-seeds, because the nudge text promises a batch and the
			 * system prompt tells the model it never has to fetch one. Sending the
			 * words without the items would leave a model that had been told twice
			 * not to call `list_unseen_items` with no way to obtain work; re-
			 * committing from its stale in-context page writes nothing new, so two
			 * such turns would trip the stall check and be recorded as a model fault.
			 *
			 * Read fresh rather than reused: the point of a nudge is that the state
			 * moved since the opening prompt.
			 */
			const nudgeBrief = await buildWorkUnitBrief({
				date: opts.date,
				manifest: opts.manifest,
				repo: opts.repo,
				screenedOutItemIds: screenedOut,
				...(turnBudget ? { decisionBudget: turnBudget.remaining } : {}),
			});
			const nudgeText = `${buildCuratorNudgePrompt({
				unseenItems: totalItems - current,
				totalItems,
				storyCount: nudgeBrief.storyIds.length,
				...(feedback !== undefined ? { lastError: feedback } : {}),
			})}\n\n${renderWorkUnitBrief(nudgeBrief)}`;
			notePrompt("nudge", nudgeText);
			await runTurn(() => driver.prompt(nudgeText));
		}

		if (!ctx.submitted) {
			const current = await decidedCount();
			throw new InvalidAgentOutputError(
				`Curator did not produce accepted materials after ${maxNudges} nudges (${current}/${totalItems} items decided, ${rejectedSubmissions} rejected submissions)` +
					(lastRejection
						? `. Last rejection: ${lastRejection}`
						: ". It never called submit_materials."),
			);
		}

		return {
			materials: ctx.submitted,
			toolCalls,
			activeToolNames: driver.getActiveToolNames(),
		};
	} catch (err) {
		/*
		 * A failure that happened while the provider reported nothing at all is
		 * the provider's, not the model's. Re-labelled here, at the only place
		 * that can still see this attempt's usage, so the router falls back at
		 * once instead of nudging something that is not there.
		 */
		throw asSilentProviderFailure(err, driver.getUsage?.(), opts.spec);
	} finally {
		// Before dispose, and on every exit including a yield: the usage of a
		// turn that yielded is exactly the figure the continuation telemetry needs.
		const usage = driver.getUsage?.();
		if (usage) opts.reportUsage?.(usage);
		driver.dispose();
	}
}
