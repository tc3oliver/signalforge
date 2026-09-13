# Working rules for this repository

These are constraints, not preferences. This system reads the day's world for one
person and has to be trusted without being checked, so each rule below protects
either that trust or the machine it runs on.

## Do not touch the global Pi installation

- Never modify `~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`, `~/.config/pi/`
  or anything under the Keychain.
- `auth.json` is read to reuse existing OAuth logins, and Pi's model catalog files
  beside it are read to resolve models. Those are the only global files this
  project depends on, and they are opened read-only.
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
- `submit_materials` enforcing 100% scan coverage is the core guarantee of the whole
  system.
  It is not negotiable and has no override flag.

## Scope

The project is now a production build: Postgres + pgvector, real collectors, live
web research, a Next.js front end and a user LaunchAgent are all in scope. See
`docs/PRODUCTION_PLAN.md` for the staged plan and current status.

What stays out, permanently and for the same reason as before:

- **MCP, and any Pi extension, package or patch.** The unattended worker stays
  restricted; capability arrives as a project-owned tool, never as a plugin.
- **Editorial filtering before Pi.** A collector may drop an item only for being an
  exact duplicate, corrupt, unsupported, or a source-policy violation. "Looks
  unimportant" is Pi's judgement and making it early is how a pipeline silently
  stops seeing things.
- **Public ingress.** This machine is LAN-only compute. No tunnel, no port forward,
  no publicly reachable database or LLM endpoint.

The synthetic fixtures and gold truth remain the acceptance harness. They are not
superseded by live data, and their thresholds are not negotiable: a gate that fails
gets a fixed policy or implementation, never a lowered bar.

## Before saying something is done

- `pnpm verify` clean (never `pnpm test` alone: it may skip the Postgres suites).
- No `TODO`, no `test.skip`, no stubbed branch presented as working.
- Never report a live model result that was actually produced by a fake runner, and
  never fill in the human score in `MANUAL_REVIEW.md`.
