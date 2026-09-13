# Open-source audit

A pre-publication security and privacy audit of this repository, performed
2026-09-13 while it was still local and unpushed.

The question it answers is narrow: **if this repository became public right now,
what about its author or its machine would become public with it?**

No credential value appears anywhere in this document. Findings name a file and
a type; where a value had to be examined to classify it, only the classification
is recorded.

## Method

| Surface | How it was covered |
|---|---|
| Tracked files | `gitleaks detect` (v8.30.1, default ruleset) plus targeted pattern search |
| Full git history | `gitleaks detect` over all 35 commits, ~4.8 MB of blobs |
| Untracked files | `git status`, `git check-ignore` on every artifact directory |
| Commit messages | `git log --all -S` pickaxe for each identifier class |
| Historical blobs | `git log --all --diff-filter=A --name-only` for files that existed once and were removed |

Pattern classes searched, independently of the scanner: API keys and bearer
tokens, OAuth tokens, GitHub tokens (`ghp_`, `github_pat_`), AWS keys, Slack
tokens, email addresses, absolute `/Users/...` paths, UID literals, hostnames,
LAN and internal IP ranges, private repository names, database credentials and
`Authorization` headers.

## Secret scan

**Result: no secrets, in the working tree or in any commit.**

`gitleaks` reported three `generic-api-key` hits, all in one file:

| File | Rule | Verdict |
|---|---|---|
| `src/fixtures/scenarios.ts` ×3 | `generic-api-key` | **False positive** |

Each is a field literally named `key` holding a story identifier
(`"gh-issue-arc"` and similar) in a synthetic test scenario. The rule matches on
the field name. The file is committed fixture data and contains no credential of
any kind.

A fourth finding appeared later, from work done during this audit:
`tests/setup-check-redaction.test.ts` needed a credential-shaped value in order
to prove that `setup:check` cannot print one. The value is fabricated and has
never been a real token. At `HEAD` it is assembled at run time so no literal
exists; commit `4b5d29d` still contains the literal and gitleaks scans history,
so the path is allowlisted rather than rewriting a commit to hide a string that
was never a secret.

All four are recorded in `.gitleaks.toml` with the reasoning, so that a clean
scan means something and CI fails on anything new. After the allowlist:
**`no leaks found`** across all 38 commits.

**`ROTATION_REQUIRED`: none.** No credential was ever committed, so nothing needs
rotating.

## Personal and machine-identifying data

Four real findings, all fixed. None had ever been a security issue; all four
would have identified the author or misattributed traffic to them.

| # | File | What it was | Fix |
|---|---|---|---|
| 1 | `src/config/secrets.ts` | A login name hardcoded as the Keychain account for `TAVILY_API_KEY` | Resolved at run time from the current login, with `KEYCHAIN_ACCOUNT` as an override. Resolves to the identical value on the original machine, and is *correct* for everyone else — a stranger's Keychain item is under their own login, not the author's |
| 2 | `src/collectors/arxiv.ts` | A personal GitHub profile URL in the `User-Agent` sent to arXiv | Names the software, not the operator; `ARXIV_USER_AGENT` overrides. As shipped it would have attributed every installation's traffic to one person |
| 3 | `tests/db-reset-guard.test.ts` | A real LAN address used as the "non-loopback host" fixture | RFC 5737 documentation address `203.0.113.10` |
| 4 | `docs/DATA_SOURCES.md` | A literal account name in a `security find-generic-password` example | `"$(id -un)"` |
| 5 | `tests/ops-plist.test.ts` | The author's home directory in five fixture paths | Representative stand-ins (fixed in the preceding commit) |

### Personal configuration

Separately from the above, and the largest privacy exposure in the repository:
`config/interests.yaml`, `config/watchlists.yaml` and `config/discovery.yaml`
contained one person's actual topics, watched repositories, tracked companies,
subreddits and YouTube channels — shipped as if they were product defaults.

An interest profile is not a secret, but it is a detailed statement of what
somebody pays attention to, and it has no business being a default that
strangers inherit.

These are now neutral examples. The operator's real configuration lives beside
them as `*.local.yaml`, is gitignored, and replaces rather than merges. The
local files were created by copying the originals byte for byte; `loadConfig`
was verified after the change to return the same 20 topics, 16 repositories and
5 discovery queries as before.

## Accepted, with reasons

Three items match the search patterns and were deliberately left in place.

**`LICENSE` — copyright holder.** Reads `Copyright (c) 2026 tc3oliver`, the
owner's GitHub account. A copyright notice naming the author is the point of
the file. **Decided 2026-09-13:** the GitHub account name is the intended
holder.

**`gui/501` in `docs/RUNBOOK.md` and `docs/SECURITY.md`.** UID 501 is the first
user account on every macOS installation, so it identifies nothing. Both sites
already state that it is an observation rather than a value to copy, and that
every script resolves the uid at run time via `id -u`; `RUNBOOK.md` says so
explicitly and forbids writing a literal uid into a script or plist. Removing
them would remove an instruction that exists precisely to stop somebody
hardcoding it.

**Author email in commit metadata.** All 35 commits carry
`oliver <…@gmail.com>` as author. This is normal for a public repository and is
how git attributes work. Removing it means rewriting every commit. *Requires a
decision* — see "Git history" below.

## Git history

**Result: no rewrite is necessary.**

| Check | Result |
|---|---|
| Secret ever committed | No |
| Production logs, briefs or database dumps ever committed | No — `git log --all --name-only` shows nothing under `runs/`, `briefs/`, `logs/` or `backups/` in any commit |
| Personal config ever committed | Yes — `config/interests.yaml` and `watchlists.yaml` have been tracked since the first commit, and the history therefore contains the author's real interest profile |
| Absolute home paths ever committed | Yes — 5 commits touch `/Users/…` strings |
| Internal IP ever committed | Yes — 1 commit (`100e3f0`), the test fixture above |

The last three are the honest cost of not rewriting. Fixing them at `HEAD`,
which is what has been done, does not remove them from history: anyone who
clones the published repository can `git log -p` and read the original interest
profile and the author's home directory.

**Recommendation: accept it.** None of it is a credential, none of it is a
security exposure, and the interest profile is the same kind of information the
brief output would reveal anyway. Squashing 38 commits of genuine development
history to hide a directory path trades something real for something cosmetic.

**Decided 2026-09-13: accepted, no rewrite.** The consequence, recorded so it
is not a surprise afterwards: anyone who clones the published repository can
`git log -p` and read the original interest profile and the author's home
directory path. This becomes irreversible at the first push.

For the record, the option that was declined: the only rewrite worth doing here
would have been a fresh initial commit (`git checkout --orphan` from the
current tree), discarding all history rather than editing it. A filter over 38
commits to scrub paths would leave the interest profile in the diffs unless it
scrubbed those too, at which point nothing of the history survives anyway.

## Production artifacts

**Result: none tracked, none ever committed.**

| Path | Tracked | Ignored |
|---|---|---|
| `runs/` | 0 files | yes |
| `briefs/` | 0 files | yes |
| `logs/` | 0 files | yes |
| `backups/` (database dumps) | 0 files | yes |
| `observations/` | does not exist | yes (added pre-emptively) |
| `.env` | 0 files | yes |
| `secrets.env` | 0 files | yes |
| `.omc/` (agent runtime state) | 0 files | yes |
| Pi auth / model stores | never in this repository — they live in `~/.pi/` | n/a |

`fixtures/generated/` is ignored; `fixtures/scenarios/` is committed synthetic
input.

The committed test data under `experiments/` (210 files, 47% of tracked files)
was audited separately: it is synthetic, with fabricated authors and
`example.com` URLs. It is retained because `src/eval/stability.ts` reads it to
produce the stability report — deleting it would make a committed report
unreproducible.

Example output for the README lives in `examples/` and is **fabricated**. A real
brief is a record of what one person read on one morning; it is not
open-source sample data.

## Third-party content

The pipeline collects from Hacker News, GitHub, arXiv, RSS, FRED, CoinGecko and
others, each under its own terms. **None of it is redistributed by this
repository:** collected content lands in `runs/`, `briefs/` and the database,
all of which are ignored. The README states that operators are responsible for
what they collect.

## Summary

| | |
|---|---|
| Secrets in tree | none |
| Secrets in history | none |
| `ROTATION_REQUIRED` | none |
| Personal data at `HEAD` | none, after the five fixes above |
| Personal data in history | yes — interest profile, home paths (accepted; see above) |
| Production artifacts tracked | none |
| History rewrite performed | none |
| Decisions outstanding | **none** — copyright holder `tc3oliver`, history accepted as-is, both 2026-09-13 |
