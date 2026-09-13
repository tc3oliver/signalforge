# Open-source release readiness — SignalForge

Prepared 2026-09-13, against a repository that has never been pushed.

## Overall status

> ## READY TO PUSH
>
> Both outstanding decisions were made by the owner on 2026-09-13: the MIT
> copyright holder is `tc3oliver`, and the git history is accepted as it stands.
> Nothing else was blocking.
>
> One judgement call remains open and is deliberately *not* treated as a
> blocker, because it is about timing rather than readiness: the five-day
> observation freeze that began 2026-09-13 has one day of evidence behind it,
> and the author's own quality review scores intelligence quality 4/10. The
> repository is ready; whether today is the right day to publish is a separate
> question, and it is the owner's.

Everything below is done and verified.

## Security and privacy audit

Full detail in [`OPEN_SOURCE_AUDIT.md`](OPEN_SOURCE_AUDIT.md).

| | |
|---|---|
| Secret scan, working tree | **clean** |
| Secret scan, all 35 commits | **clean** |
| `ROTATION_REQUIRED` secrets | **none** |
| Personal identifiers at `HEAD` | **none**, after five fixes |
| Production artifacts tracked | **none** |
| History rewrite performed | **none** |

`gitleaks` 8.30.1 over the full history reported three findings, all in
`src/fixtures/scenarios.ts`, all fields literally named `key` holding synthetic
story identifiers. Examined, judged false positives, recorded in
`.gitleaks.toml`; the scan is then clean and CI fails on anything new.

Five real privacy findings, all fixed: a hardcoded Keychain login name, a
personal GitHub URL in the arXiv `User-Agent` sent from every installation, a
real LAN address in a test fixture, a literal account name in a documented
command, and the author's home directory in `tests/ops-plist.test.ts`.

### Git history audit

No rewrite is necessary and none was performed. No credential, log, brief or
database dump was ever committed.

The history does contain the author's real interest profile and home directory
paths, because `config/interests.yaml` has been tracked since the first commit.
Fixing that at `HEAD` does not remove it from history. **Recommendation: accept
it.** None of it is a credential or a security exposure. See the audit for the
reasoning and for the only rewrite that would actually help if you disagree.

## Personal configuration separation

`config/interests.yaml`, `watchlists.yaml` and `discovery.yaml` were one
person's actual topics, repositories, companies, subreddits and channels,
shipped as product defaults.

They are now neutral examples. The operator's real configuration lives beside
them as `*.local.yaml`: gitignored, and **replacing rather than merging** — a
deep merge would put the effective configuration in neither file, with a
deleted default quietly still steering the brief.

**Production is unaffected.** The local files were created by copying the
originals byte for byte, verified identical by checksum, and `loadConfig` was
then re-run: 20 topics, 16 repositories, 5 discovery queries, exactly as before.
`tests/config-local-override.test.ts` pins the precedence.

## Example configuration and demo

| | |
|---|---|
| `config/*.yaml` | Shipped examples, small and neutral, each documenting its own shape |
| `examples/` | A synthetic brief, run summary and four-day story ledger — all fabricated |
| `pnpm demo` | The existing three-day synthetic seed, promoted to a documented entry point |

`pnpm demo` needs no model, no credential and no network, and writes to its own
lineage where it cannot touch `default`. Verified in a clean clone with `HOME`
pointed at a nonexistent directory and every credential unset: `3 briefs, 16
items, 4 signals`, exit 0.

No real brief is published as sample data. A brief is a record of what one
person read on one morning.

## README and onboarding

README is rewritten as a public front page: tagline, what it is, why
event-centric rather than article-centric, an ASCII architecture diagram, the
eight change types, features, quick start, data sources by credential
requirement, model portability, security model, and limitations.

The limitations section says plainly that personalization does not learn, that
the curator is expensive by design, that a fresh install has no history so
everything is `NEW` at first, and that unattended scheduling as shipped is
macOS-only. `docs/reports/QUALITY_REVIEW.md` is linked from the status section
as the author's own critical assessment.

New commands: `pnpm setup:check` (read-only preflight, prints credential names
and never values) and `pnpm demo`.

## CI

`.github/workflows/ci.yml` runs the real `pnpm verify` path against a
`pgvector/pgvector:pg17` service, with `DI_REQUIRE_INTEGRATION=1` so a missing
database is a hard failure rather than a skip, and then asserts the
skipped-test count is **zero** from the JSON reporter. A separate job runs
`gitleaks` with the committed config.

**CI needs no credential of any kind** — no Pi OAuth, no Copilot subscription,
no API key. Nothing in the test suite contacts a model: the integration tests
drive the real tools, validators, repository and orchestrator through a fake
agent driver. A fork's pull request gets exactly the same run as a push to
main. Anything needing a live provider stays out of CI by construction.

## Clean-clone smoke test

A fresh `git clone` into a temporary directory, with no access to the author's
config, secrets, database or Pi state, against a throwaway database that was
dropped afterwards.

| Step | Result |
|---|---|
| Clone carries only neutral config | 5 example topics, 2 example repos |
| Clone contains no personal identifier | confirmed, zero matches |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm db:migrate` on an empty database | 3 applied, 0 already present |
| `pnpm verify` | pass, **62 files / 745 tests / 0 skipped**, web build |
| `pnpm demo` with no credentials and no `HOME` | pass |
| `pnpm setup:check` with nothing configured | clear, actionable, no values printed |

**It found three defects that local testing could not have.** All three are
fixed, each with a regression test:

1. **`pnpm install` never installed `web/`.** It is a separate package, not a
   workspace member. On any machine where `web/node_modules` already existed
   this was invisible; on a fresh clone `pnpm verify` ran through 745 passing
   tests and then died on `next: command not found` — the worst possible shape
   for a first-run failure, because everything before it said the install had
   worked. Fixed with a `postinstall` hook.
2. **`setup:check` ignored `DAILY_INTELLIGENCE_SECRETS_FILE`.** It passed an
   empty environment to keep itself read-only, but the file's path is read from
   that same environment, so the override was invisible and the check silently
   reported on the wrong file.
3. **`setup:check` reported `not reachable ()`** on a refused connection.
   Fixing it introduced a way to print a password, since `DATABASE_URL` carries
   one; the target is now parsed for host/port/database with the userinfo
   dropped, and `tests/setup-check-redaction.test.ts` drives the real CLI with
   a password and a token in the environment to prove neither can reach the
   output.

## License, contributing, security policy

| | |
|---|---|
| `LICENSE` | MIT, complete and unmodified text, `Copyright (c) 2026 tc3oliver` |
| `package.json` | `"license": "MIT"`, consistent with README |
| `CONTRIBUTING.md` | Development setup, tests, the acceptance rules, how to add a collector, what evidence a policy change needs |
| `.github/SECURITY.md` | Private vulnerability reporting, no personal address |

`CONTRIBUTING.md` states explicitly that no contributor needs the providers
named in `config/agent.yaml`.

`.github/SECURITY.md` names prompt injection through collected content as
in-scope, the restricted agent runtime as a boundary, and third-party model
providers as a trust boundary with the operator's own decision attached.

## Tracked production artifacts

None. `runs/`, `briefs/`, `logs/`, `backups/`, `.env`, `secrets.env`, `.omc/`
and `config/*.local.yaml` are all ignored and none has ever been committed.
`observations/` is ignored pre-emptively.

## Files intentionally excluded from the public repository

Nothing is excluded. Everything tracked is intended to be public, including
`docs/reports/`.

Those reports are dated evidence and several cite this machine's uid and paths
as observed facts. They are **not** sanitised: revising a record to look better
in retrospect falsifies it, and the information in them — a macOS uid of 501, a
home directory name — is not sensitive. `docs/README.md` states the contract
that reports are never updated after the fact.

## Platform assumptions

| | |
|---|---|
| Core application | Node 24 + PostgreSQL 17 with pgvector. No macOS dependency |
| Scheduling as shipped | macOS LaunchAgent |
| Keychain fallback for secrets | macOS only; `secrets.env` and environment variables work everywhere |
| Linux / Docker deployment | **Not officially validated yet.** Nothing is known to prevent it, and nothing has been tested |

The README states this rather than implying portability that has not been
demonstrated.

## Known public-release limitations

- **Brief quality is unproven in public terms.** The author's own
  `QUALITY_REVIEW.md` scores intelligence quality 4/10 and product value 4/10
  against engineering quality 7/10. A five-day observation freeze started
  2026-09-13 and has one day of evidence.
- **Personalization does not learn.** Keyword and weight driven, tuned by hand.
- **The curator scans every collected item by design**, so cost scales with
  collection volume rather than with output.
- **Emerging signal detection is the least mature component.**
- **A fresh install has no ledger**, so historical awareness is worthless for
  the first several days and the product does not look like itself.
- **Several connectors are optional and off by default.**

## Observation freeze

Honoured. No prompt, threshold, gold file, interest profile, model chain,
source configuration or collector scope was changed. The agent-facing skill text
was deliberately left alone during the rebrand for exactly this reason, even
though it still says `daily-intelligence`.

## Decisions taken

Both were made by the owner on 2026-09-13.

**1. Copyright holder — settled.** `LICENSE` reads
`Copyright (c) 2026 tc3oliver`, the owner's GitHub account, and `package.json`
declares `"license": "MIT"` to match. The MIT text is complete and unmodified.

**2. Git history — accepted as it stands.** No rewrite will be performed. The
consequence, stated plainly so it is not a surprise later: old commits contain
the author's original interest profile and home-directory paths, and anyone who
clones the published repository can read them with `git log -p`. None of it is
a credential; the audit sets out why this is a reasonable trade. This decision
becomes irreversible at the first push, which is exactly why it was made
deliberately rather than by default.

Noted, not blocking: the author's email appears in all 38 commits as git
author metadata, which is normal for a public repository and was not raised as
a concern.

## Still open, by choice

The observation freeze (2026-09-13 to 2026-09-18) has one day of evidence. The
author's own `QUALITY_REVIEW.md` scores intelligence quality 4/10 and product
value 4/10. Publishing today is defensible — the README and the limitations
section are honest about exactly this, and `QUALITY_REVIEW.md` is linked from
the README rather than buried. Waiting until the freeze ends would mean the
quality claims rest on five days rather than one.

That is a judgement about timing, not about readiness, and it belongs to the
owner. It is recorded here so the choice is visible rather than implicit.

## Suggested repository

`github.com/tc3oliver/signalforge`, description: *Self-hosted AI intelligence
pipeline that turns noisy multi-source data into deduplicated events, emerging
signals, and source-grounded daily briefs.*

`package.json` declares that URL in `repository`, `homepage` and `bugs`, and the
README's clone command uses it. **The repository does not exist yet.** No remote
has been configured here and nothing has been pushed; creating it and pushing
are the owner's to do.

Suggested topics: `ai`, `agents`, `llm`, `intelligence`, `news-aggregator`,
`rss`, `self-hosted`, `daily-brief`, `knowledge-management`, `typescript`,
`postgresql`.
