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

## Security

Do not open a public issue for a vulnerability. Mail the address on the commit
history instead, and give it time before disclosing.

The threat model is written down in [`docs/SECURITY.md`](docs/SECURITY.md),
including what is deliberately out of scope. Two invariants matter most:

- **The agent sessions are restricted.** No shell, no filesystem beyond one
  narrowly-rooted reader, no arbitrary HTTP, no credentials. A change that
  relaxes any of that needs to say so in its description, in those words.
- **External content is untrusted.** Everything collected is treated as hostile
  input and marked as such before an agent sees it. Prompt injection through a
  collected item is in scope and worth reporting.

Never include a real credential in an issue, a pull request or a test fixture.
