# Contributing

Read this before opening anything — it is short, and it is mostly about
expectations rather than process.

## What this project is

A personal daily-intelligence pipeline that runs on one machine for one reader.
It is published because the design may be useful to read and adapt, not because
it is a product. There is no roadmap, no release cadence and nobody on call.

That has consequences worth stating up front:

- **Issues may go unanswered.** A bug report that includes a reproduction is
  genuinely useful and may still sit untouched. If you need it fixed, fix it.
- **Feature requests are usually declined.** The scope is one reader's morning
  brief. Generalising it — multi-tenancy, a plugin system, a hosted mode — makes
  it worse at the only job it has.
- **Forking is the expected outcome.** The interest profile, the watchlists and
  the editorial policy encode one person's taste. Yours will differ, and the
  honest way to express that is a fork, not a configuration flag.

## If you do send a change

The bar is the same one the project holds itself to.

- `pnpm verify` must pass: typecheck, the full suite with **no suite permitted to
  skip**, and the web build. A green run that silently skipped the data layer is
  treated as a failure here, not a pass.
- New behaviour needs a test that would have failed before the change. Tests that
  assert the implementation back to itself are not evidence.
- `test.skip`, `.only`, TODO placeholders and unimplemented branches are
  blockers, not progress.
- Do not weaken an acceptance gate, a threshold or a gold file to make a result
  fit. If the gate is wrong, argue that separately and on its own evidence.
- Follow the surrounding code: it favours explanatory comments about *why* over
  restating *what*, and prefers a named function to a clever expression.

## Development setup

```bash
pnpm install
cp .env.example .env          # then set a local POSTGRES_PASSWORD in both places
docker compose up -d          # Postgres 17 + pgvector, loopback only
pnpm db:migrate
pnpm setup:check              # read-only; prints no credential values
```

You do **not** need the model providers named in `config/agent.yaml`. Nothing in
the test suite contacts a model: the integration tests drive the real tools,
validators, repository and orchestrator through a fake agent driver, so resume,
cross-provider fallback, rejection handling and the run lifecycle are all
covered without spending a token. Use whatever provider you have, or none.

You also do not need any collector credential. Sources without a key report
`DISABLED` and the run continues.

## Tests

```bash
pnpm test                # fast; may skip the Postgres-backed suites
pnpm test:integration    # same suite, but skipping is a failure
pnpm typecheck
pnpm build
pnpm verify              # typecheck -> fixtures -> test:integration -> build
```

**Report results from `pnpm verify`, never from `pnpm test` alone.** `pnpm test`
is the one you run while working and is allowed to skip the database-backed
suites so it stays usable without Postgres up. That convenience has already
misled once: a run with no database reported `622 passed | 42 skipped`, exit 0,
green — with the entire data layer, the pipeline state machine and the
gold-isolation *security* test silently absent. Under `pnpm verify`,
`DI_REQUIRE_INTEGRATION=1` turns each of those skips into a hard failure that
names what to start.

CI runs `pnpm verify` against a real Postgres service and then asserts the
skipped-test count is zero.

The fixture harness, fault injection, run artifacts and how to read a failed
run are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Acceptance expectations

Some of this project's rules exist because breaking them is tempting and
invisible:

- **Do not weaken a test to make it green.** Not a threshold, not an acceptance
  gate, not a gold file. A failing gate gets a fixed implementation or a
  separately argued change to the gate — never a lowered bar to fit a result.
- **Do not let a model grade its own work.** Validation is deterministic:
  claims resolve against the database, or they fail. "The output looks good" is
  not evidence.
- **`test.skip`, `.only`, TODO placeholders and unimplemented branches are
  blockers**, not progress.
- **New behaviour needs a test that fails without the change.** A test that
  asserts the implementation back to itself proves nothing.
- Run the synthetic fixture dates **in order**. Day N's novelty judgements
  depend on the ledger day N−1 wrote; running them out of order makes every
  story look `NEW` and the failure looks like a bug elsewhere.

## Adding a collector

1. Implement it in `src/collectors/<name>.ts` against the `Collector` interface
   in `src/collectors/types.ts`. Return normalized items; **a collector does no
   editorial filtering** — deciding what matters is the curator's job, and a
   collector that pre-filters hides items from the only stage that can judge
   them.
2. Give every item a **stable** `sourceExternalId`. It is the deduplication
   identity across runs, so it must be derived from the source's own identifiers
   — never a timestamp, a random value or a hash of the fetch time. This has
   been a real bug here more than once.
3. Add the source type to `src/schemas/item.ts` and an entry to
   `config/sources.yaml` (every field is required; the schema is `.strict()`).
4. Name any credential in `requiredSecrets` as a logical name resolved through
   `src/config/secrets.ts`. Never read `process.env` for a key directly, and
   never put a value in a config file.
5. **A missing credential must degrade, not fail.** Report `DISABLED` or
   `DEGRADED` with a reason; the run continues.
6. Add tests covering the identity, incrementality, the timeout path and the
   missing-credential path. `tests/collector-*.test.ts` has the shape.

## Changing the Skill, prompts or editorial policy

`agent/skills/` holds the curator and editor policy: what counts as a story,
how duplicates are judged, what may be written. Changing it changes what the
product decides is worth reading.

That is a different kind of change from a bug fix, and a passing test suite does
not establish that it was an improvement. A pull request that touches policy
should say what evidence supports it — a run comparison, a stability
measurement, days of observed output — and should expect to be held to that
rather than to a green check. Policy changes bundled into an unrelated fix will
be asked to come out.

## Security


Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on the repository, as [`.github/SECURITY.md`](.github/SECURITY.md)
describes, and give it time before disclosing.

The threat model is written down in [`docs/SECURITY.md`](docs/SECURITY.md),
including what is deliberately out of scope. Two invariants matter most:

- **The agent sessions are restricted.** No shell, no filesystem beyond one
  narrowly-rooted reader, no arbitrary HTTP, no credentials. A change that
  relaxes any of that needs to say so in its description, in those words.
- **External content is untrusted.** Everything collected is treated as hostile
  input and marked as such before an agent sees it. Prompt injection through a
  collected item is in scope and worth reporting.

Never include a real credential in an issue, a pull request or a test fixture.
