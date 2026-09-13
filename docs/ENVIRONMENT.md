# Environment — verified, not assumed

Everything here was read off this machine. Nothing was taken from a tutorial or a
changelog. Where a fact could not be checked at the time of writing, it says so.

## Toolchain

| Thing | Value | How it was checked |
|---|---|---|
| Pi | 0.85.1 | `pi --version` |
| Node | v24.21.0 | `node --version`, mise-managed |
| pnpm | 10.34.5 | `pnpm --version`, mise-managed |
| `pi` binary | `~/.local/share/mise/installs/node/24/bin/pi` | `which pi` |
| Docker client / server | 29.4.0 / 29.4.0 | `docker version`; OrbStack, context `orbstack` |

`package.json` sets `engines.node >= 24`.

**Node and pnpm are mise-managed.** That is this project's operational assumption,
not an incidental detail: `scripts/install-launchagent.sh` resolves `node` and `pnpm`
with `command -v` and bakes the resulting `dirname` into each plist's `PATH`, because
a launchd job runs with none of the interactive shell's PATH or aliases. If the
runtime manager changes, the installed plists are stale and must be regenerated.

**Docker is OrbStack.** There is no second engine and no Colima on this machine; the
active context is `orbstack`. The backup and restore scripts run `pg_dump`, `psql`
and `createdb` *inside* the container rather than on the host, because there are no
Postgres client binaries installed here and running in-container keeps client and
server versions in step.

## Data plane

| Thing | Value | Source |
|---|---|---|
| Postgres image | `pgvector/pgvector:pg17` | `compose.yaml` |
| Container name | `daily-intelligence-postgres` | `compose.yaml` |
| Host binding | `127.0.0.1:${POSTGRES_PORT:-55432}` → `5432` | `compose.yaml` |
| Volume | `daily-intelligence-pgdata` | `compose.yaml` |
| initdb args | `--locale=C --encoding=UTF8` | `compose.yaml` |
| Extensions | `vector`, `pg_trgm` | `db/migrations/001_init.sql` |

**Postgres is bound to loopback only.** The port mapping is `127.0.0.1:…`, not
`0.0.0.0:…`, and that is deliberate: this machine is LAN compute and the datastore
must not be reachable from the LAN. The non-default host port (55432) avoids
colliding with any other Postgres already running here. `scripts/lib-db-env.sh`
refuses any `PGHOST` that is not `127.0.0.1` or `localhost`, so the backup/restore
tooling cannot reach another service's database even with a mistyped env value.

The `--locale=C` collation is chosen so text ordering in queries does not drift with
the host locale.

## Runtime dependencies

Root `package.json`:

| Package | Version |
|---|---|
| `@earendil-works/pi-coding-agent` | 0.85.1 |
| `postgres` | ^3.4.9 |
| `typebox` | 1.3.7 |
| `yaml` | ^2.9.1 |
| `zod` | ^4.1.12 |

Dev: `@types/node` ^24.7.0, `tsx` ^4.20.6, `typescript` ^5.9.3, `vitest` ^3.2.4.

`web/package.json`:

| Package | Version |
|---|---|
| `next` | 15.5.4 |
| `react` | 19.1.1 |
| `react-dom` | 19.1.1 |

The web app binds to `127.0.0.1:3300` by default in both `dev` and `start`
(`next dev -H ${WEB_HOST:-127.0.0.1} -p ${WEB_PORT:-3300}`), for the same reason
Postgres does. `WEB_HOST` / `WEB_PORT` override it deliberately; every route is
read-only and unauthenticated, and `/admin` stays off unless `SIGNALFORGE_ADMIN=1`.

## Pi packages actually installed

| Package | Version |
|---|---|
| `@earendil-works/pi-coding-agent` | 0.85.1 |
| `@earendil-works/pi-ai` | 0.85.1 (transitive) |
| `typebox` | 1.3.7 |

`pi-ai` is a transitive dependency of `pi-coding-agent`, resolved through the pnpm
store and not importable from this project. The `Model` type is therefore taken from the
runtime API (`ReturnType<ModelRuntime["getModel"]>`) rather than imported.

**The TypeBox package is `typebox`, not `@sinclair/typebox`.** Custom tool parameters
use `import { Type } from "typebox"`.

## Model IDs used by the pipeline

The chain that runs is `modelChain` in `config/agent.yaml`, read at run time.
`MODEL_CHAIN` in `src/runtime/model-config.ts` is the compiled-in default, and
`tests/model-chain-config.test.ts` fails if the two ever disagree.

| Role | Provider | Model | Chain position |
|---|---|---|---|
| Primary | `github-copilot` | `gemini-3.8-flash` | 1 |
| Fallback 1 | `openai-codex` | `gpt-5.6-sol` | 2 |
| Fallback 2 | `opencode-go` | `deepseek-v4.1-flash` | 3 |

There is no separate curator model and editor model. Both stages walk the same chain;
what differs is the tool set and the prompt, not the model.

Note the dots: `gemini-3.8-flash`, not `gemini-3-8-flash`; `deepseek-v4.1-flash`, not
`deepseek-v4-flash` (which is a different, also-present model).

Per-stage tuning also lives in `config/agent.yaml`: `CURATOR` and `EDITOR` each get
`timeoutMs: 300000`, `maxAttemptsPerModel: 4`, `maxNudges: 3`.

## SDK facts this project depends on

Read from the installed package itself, under
`node_modules/@earendil-works/pi-coding-agent/` — its `dist/*.d.ts`, its own
`docs/sdk.md`, and `examples/sdk/` — not from the public docs site.

- `createAgentSession({ noTools: "all", customTools, tools })` yields a session whose
  active tool set is exactly the custom tools. Verified per run in
  `restricted-runtime.json`: 12 curator tools (13 when `search_web` is configured)
  and 7 editor tools, and nothing else.
- A `ResourceLoader` supplied explicitly replaces ALL discovery — global extensions
  (`pi-web-access`, `pi-usage`), agents-file walking, prompt templates and themes.
- `SettingsManager.inMemory()` means the global `~/.pi/agent/settings.json` is
  neither read nor written.
- `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })` reuses the
  existing OAuth logins. **`refreshOnCreate` must be `true`** or the cached catalog
  in `models-store.json` is not restored and `deepseek-v4.1-flash` fails to resolve
  (only statically-bundled models survive). `allowModelNetwork: false` still keeps it
  off the network.
- **Pi's skill mechanism is lazy and needs a file-read tool.** `buildSystemPrompt`
  only appends `formatSkillsForPrompt(...)` when `read` or `bash` is among the active
  tools, because the advertisement tells the model to open `SKILL.md` itself. A
  restricted runtime has neither, so Pi's own path is inert here. See
  `docs/ARCHITECTURE.md` for how this project keeps a real Pi skill anyway.
- Tools signal rejection by **throwing**; `AgentToolResult` has no `isError` field.
  `terminate: true` on a result asks the agent loop to stop after the batch.

## Configuration surface

| File | Holds |
|---|---|
| `config/interests.yaml` | weighted topics with keywords and aliases |
| `config/watchlists.yaml` | `github_repos`, equities, crypto ids, macro series, `subreddits`, `youtube_channels`, `arxiv_categories` |
| `config/sources.yaml` | one entry per `SourceType`: `enabled`, `baseUrl`, `rateLimitPerMinute`, `timeoutMs`, `pageSize`, `requiredSecrets` (plus SEC-only `userAgent`) |
| `config/discovery.yaml` | named discovery queries with a schedule and topic ids |
| `config/agent.yaml` | model chain, per-stage tuning, `searchWeb` budgets |

All five are parsed by strict Zod schemas in `src/config/schema.ts`;
`SourcesConfig` additionally requires one entry per `SourceType` value.

## Environment variables

From `.env.example`, the database settings:

| Variable | Purpose |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | consumed by `compose.yaml` |
| `DATABASE_URL` | read first by the app; `PGHOST`/`PGPORT`/… are the fallback |
| `DI_LINEAGE` | ledger namespace (default `default`); experimental runs set their own so they can never collide with production rows in the same database |

Other variables the code reads, none of them required:

| Variable | Purpose |
|---|---|
| `DAILY_INTELLIGENCE_SECRETS_FILE` | alternative path for the collector secrets file (default `~/.config/daily-intelligence/secrets.env`) |
| `KEYCHAIN_ACCOUNT` | account name used for Keychain-mapped secrets |
| `MINIFLUX_URL` | overrides `rss.baseUrl`; the only config key with an environment override |
| `DI_REQUIRE_INTEGRATION` | set by `pnpm verify`; turns any infrastructure skip into a failure |
| `DI_SEED_LINEAGE` | lineage written by `pnpm demo` (default `web-dev`) |
| `WEB_HOST` / `WEB_PORT` | reader bind address and port (default `127.0.0.1:3300`) |
| `SIGNALFORGE_ADMIN` | `1` enables the `/admin` routes |
| `DAILY_INTELLIGENCE_FAULT_INJECTION` | test-only fault injection, `docs/DEVELOPMENT.md`; absent in normal operation |

Collector credentials are listed per source in `docs/DATA_SOURCES.md` and
`docs/CREDENTIALS.md`; none of them lives in `.env`.

## What was deliberately NOT touched

`~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`, `~/.config/pi/`, the Keychain,
the globally installed `pi-web-access` and `@narumitw/pi-usage`. No Pi extension was
installed for this project, and no third-party package was patched.
`~/.pi/agent/auth.json` is opened read-only for OAuth reuse; the Pi model catalog
files beside it are the only other global files this project reads.
