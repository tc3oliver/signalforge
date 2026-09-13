# SignalForge — web reader

A Next.js (App Router, TypeScript) reader for the briefs this repo produces. It
renders what the pipeline has already published to Postgres and does nothing
else.

## The one rule

**A web request never invokes a language model.** Pages are Server Components
that read rows. Nothing under `web/` may import `@earendil-works/pi-coding-agent`
or anything from `src/runtime/pi-runtime.ts`; `tests/web-no-llm.test.ts` walks
every file here and fails the build if that ever changes.

Two consequences worth stating explicitly:

- **Numbers come from `structured_facts`, by reference.** A brief story carries
  fact *ids*; `web/lib/facts.ts` reads the canonical value, unit and as-of stamp
  out of the store at render time, exactly as `src/renderer/markdown.ts` does. A
  number that only exists in model prose has no path into a page. An unresolvable
  fact id renders as an explicit gap, never as a substituted figure.
- **Stored source content is untrusted.** Titles, summaries and URLs from RSS,
  Reddit, HN and scraped pages are rendered as React text nodes (escaped), and
  every source URL passes `safeExternalUrl` so a `javascript:` href from a feed
  can never reach the DOM. `dangerouslySetInnerHTML` appears nowhere, which is
  also enforced by test.

## Layout

```
web/
  app/                 routes (all force-dynamic, nodejs runtime)
  components/          presentational components
  lib/                 pure helpers (sections, format, facts, trace, feed,
                       untrusted) + server-only db.ts / queries.ts
  scripts/seed-dev.ts  development seed
```

`web/lib/*.ts` is deliberately free of React and Next imports for the pure
modules, so `tests/web-*.test.ts` can exercise section ordering, empty-section
omission, fact rendering, confidence mapping, date formatting and the item trace
without a running server.

Data access goes through the repo's existing typed query layer in `src/db/*.ts`.
`web/lib/queries.ts` only composes those functions into page-shaped reads — it
contains no SQL — so the reader and the pipeline can never disagree about what a
story, a fact or a decision is.

## Routes

| Route | What it shows |
|---|---|
| `/` | Today dashboard: hero (date, the analysis's opening line, counts), must-know cards, what changed, emerging signals, compact topical sections, analysis preview, watch next, and a short "new since morning" inbox at the bottom |
| `/brief/[date]` | The full long-form brief: the same hero and cards first, then every story in full, signals, the whole analysis, watch next |
| `/story/[id]` | Summary, timeline across days, primary/all sources, related stories, historical context |
| `/history` | Every published brief, newest first |
| `/signals` | `emerging_signals` grouped by lifecycle state |
| `/search` | Postgres full-text search over brief stories and collected items |
| `/admin` | Entry points plus the item-trace lookup |
| `/admin/runs` | Run status, stage timings/models, fallback attempts, scan coverage, validation failures |
| `/admin/sources` | Collector health, throughput, latency, credential-blocked sources |
| `/admin/item/[id]` | "Why did this item not reach the brief?" — the full trace |
| `/feed.xml` | Atom index of published briefs |

The dashboard is a pure derivation of published rows -- `web/lib/dashboard.ts`
turns the brief, its ledger rows for the day, the tracked signal records and
the late items into a view model; nothing on the page is generated for the
page. Change type and importance come from `story_ledger` (the brief story
carries neither), source counts are the length of the cited id list, and the
hero line is the first sentence or two of `dailyAnalysis`.

Sections on a brief page follow the fixed order Must Know, AI/LLM,
Developer/Open Source, Research, Crypto/Market, Macro, Companies, Emerging
Signals, Daily Analysis, Watch Next — and a section with no material content is
omitted entirely rather than rendered empty.

## Installing and running

`web/` has its **own** `package.json` and `node_modules`, installed
independently. The repo root has no `pnpm-workspace.yaml`, and adding one would
rewrite the root lockfile for every other workstream in this repo; a standalone
install keeps the Next dependency tree out of the pipeline's. Imports of
`../src/**` still work because `next.config.ts` sets
`experimental.externalDir`, and `postgres`/`zod` resolve from the repo root's
`node_modules` the way they do for any other file under `src/`.

```sh
pnpm --dir web install       # once
pnpm run web:build           # from the repo root
pnpm run web:start           # http://127.0.0.1:3300
pnpm run web:dev             # dev server, same address
pnpm run web:seed            # development data (see below)
```

`web/.env.local` is a symlink to the repo's `.env`, so `DATABASE_URL` and
`DI_LINEAGE` resolve from the single canonical file rather than a second copy.
`DATABASE_URL` is a plain server variable — never `NEXT_PUBLIC_` — and
`web/lib/db.ts` throws if it is ever pulled into a client bundle.

The server binds `127.0.0.1` by default; `WEB_HOST` and `WEB_PORT` override
that. `/admin` is off unless `SIGNALFORGE_ADMIN=1`. There is no authentication.

## Development data

`pnpm run web:seed` writes a complete three-day history — runs, collection runs,
items, decisions, a story that evolves across all three days, facts, briefs, a
rejected draft and a signal in each lifecycle state — into the **`web-dev`**
lineage, never into `default`. Re-running replaces the seed rather than layering
onto it. Read it with:

```sh
DI_LINEAGE=web-dev pnpm run web:start
```

The seed deliberately includes hostile content (a title containing an `<img
onerror=...>` tag and an item whose URL is `javascript:`) so the escaping and
URL-scheme rules are visible in a real page, not only in a test.
