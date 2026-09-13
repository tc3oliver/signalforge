# Working rules for this repository

These are constraints, not preferences. Phase 1 exists to prove one thing, and each
rule below protects that proof.

## Do not touch the global Pi installation

- Never modify `~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`, `~/.config/pi/`
  or anything under the Keychain.
- `auth.json` is read to reuse existing OAuth logins. That is the only global file
  this project depends on, and it is opened read-only.
- Never install a Pi extension, package or MCP server for this project. Never patch
  `pi-web-access`, `@narumitw/pi-usage` or the Pi source.

## Do not weaken the restricted runtime

- The agent gets custom tools and nothing else. Never add `bash`, `read`, `write`,
  `edit`, `grep`, `find` or `ls`, and never relax `noTools: "all"`.
- Never let the global `DefaultResourceLoader` be used — discovery must stay sealed.
- `assertRestricted()` failing is a real failure. Do not downgrade it to a warning.
- `read_skill_reference` is the single filesystem read in the system, rooted at the
  skill directory. Do not widen its root or accept absolute paths.

## Do not expose credentials

- No token, key or `Authorization` header may reach a log, an event, an attempt
  record or a run artifact. `sanitizeValue()` in the error classifier strips these
  recursively; extend it rather than bypassing it.

## Keep gold truth away from the agent

- `eval/gold/` is read by the evaluator and by nothing else. No tool may return it,
  reference it, or hint at it.
- Fixture items carry no gold field — `NormalizedItem` is a strict Zod object, so a
  leak fails the parse. Keep it that way.
- Skill and prompt text must never mention evaluation, metrics, thresholds or the
  fact that output is graded.

## Deterministic validation is the trust boundary

- Agent output is accepted through `submit_materials` / `submit_brief` only. Never
  parse JSON out of an assistant message.
- Never relax a validator to make a live run pass. A rejected submission is a
  result; record it and let the model correct itself.
- `submit_materials` enforcing 100% scan coverage is the core Phase 1 guarantee.
  It is not negotiable and has no override flag.

## Phase 1 scope

Do not add, in this phase: PostgreSQL, pgvector, Next.js, a LaunchAgent or any
scheduler, MCP, real collectors (Miniflux, GitHub, HN, arXiv, CoinGecko, FRED, SEC,
Reddit, YouTube), or live web research. Phase 1 runs offline against synthetic
fixtures on purpose.

## Before saying something is done

- `pnpm typecheck` and `pnpm test` both clean.
- No `TODO`, no `test.skip`, no stubbed branch presented as working.
- Never report a live model result that was actually produced by a fake runner, and
  never fill in the human score in `MANUAL_REVIEW.md`.
