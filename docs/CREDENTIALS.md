# Credentials

There are two kinds of credential around SignalForge, and they have different
owners. Keeping that straight is most of what this page is for.

| | Model authentication | Collector credentials |
|---|---|---|
| Used by | The Pi agent runtime, to talk to a model provider | Collectors and the research layer, server-side |
| Authority | **Pi.** `pi auth login`, `~/.pi/agent/auth.json`, or a provider environment variable Pi recognises | **SignalForge.** `~/.config/daily-intelligence/secrets.env`, an explicit environment variable, or the macOS Keychain |
| Does SignalForge store it? | **No.** It reads Pi's existing logins read-only and writes nothing back | It never writes one either; it only reads names from the file or Keychain at startup |
| Where the value ends up | With Pi and the provider | In the collector process, never in an agent session |

## Model authentication — Pi is the authority

The model chain in `config/agent.yaml` names a `provider` and a `model`, nothing
more. Whether that provider is reachable is a question for Pi:

```bash
pi models          # what the installed Pi can offer
pi auth check      # whether it can authenticate as each provider
```

`src/runtime/pi-runtime.ts` creates one Pi `ModelRuntime` per process pointed
at Pi's global auth and model catalog files, with `allowModelNetwork: false` so
the runtime never fetches a catalog over the network and never rewrites the
global Pi files it reads. **SignalForge does not own or persist model
credentials; Pi remains the authentication authority.**

Any provider Pi supports works the same way here — a subscription login, a
direct API key, or an OpenAI-compatible endpoint you host yourself. If you use a
direct API key, give it to Pi the way Pi documents: `pi auth login`, or the
provider's environment variable (for example `ANTHROPIC_API_KEY`) in the
environment the run starts from. Pi resolves those variables itself.

Because `secrets.env` is loaded into the worker's environment before the model
runtime is created, a provider variable placed there *will* be visible to Pi in
that process. That is a convenience, not a requirement, and it does not make
SignalForge the owner of the credential: nothing in this repository reads,
validates, logs or stores it. If you would rather keep model credentials
entirely out of SignalForge's reach, log in with `pi auth login` instead and
leave them out of the file.

## Collector credentials — `secrets.env`, environment, Keychain

Collector credentials go in **`~/.config/daily-intelligence/secrets.env`** —
outside this repository, mode `600` in a `700` directory. It is loaded at worker
startup, so both `pnpm collect`/`pnpm daily` and the scheduled LaunchAgents pick
it up with no extra wiring.

```sh
$EDITOR ~/.config/daily-intelligence/secrets.env    # one KEY=value per line
pnpm collect                                        # reports each source's health
```

| Source | Credential | Without it |
|---|---|---|
| Hacker News | none | full function |
| arXiv | none | full function |
| CoinGecko | none | full function (public tier) |
| SEC EDGAR | none, but requires a contact User-Agent | disabled until you set one |
| GitHub | optional `GITHUB_TOKEN` | works unauthenticated at a much lower rate limit; some repos 403 |
| YouTube | optional `YOUTUBE_API_KEY` | RSS per channel still works; `@handle` resolution and discovery are skipped (`DEGRADED`) |
| Semantic Scholar | optional `SEMANTIC_SCHOLAR_API_KEY` | works at a lower rate limit |
| RSS / Miniflux | **required** `MINIFLUX_URL` + `MINIFLUX_API_KEY` | `DISABLED` |
| Reddit | **required** `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `DISABLED` |
| FRED | **required** `FRED_API_KEY` | `DISABLED` |
| Web research | **required** `TAVILY_API_KEY` (or `EXA_API_KEY`) | the `search_web` tool is not offered to the curator at all |

A missing credential is never an error. The collector reports `DISABLED`, the
run continues, and the brief is correspondingly thinner. Running with no
credentials at all is a supported configuration — it is just mostly Hacker News
and arXiv. Per-collector detail is in [`DATA_SOURCES.md`](DATA_SOURCES.md).

A name left blank is treated as absent: the loader sets nothing, the Keychain
fallback still applies, and the collector that needs it stays `DISABLED` rather
than failing the run. A missing file is equally fine.

One entry in that file is not a credential: `MINIFLUX_URL`. A Miniflux instance
lives at a different address on every machine, and the key is useless without it,
so it overrides `rss.baseUrl` in `config/sources.yaml` rather than being checked
in. It is the only config key with an environment override.

Precedence is **explicit environment variable → `secrets.env` → Keychain**. An
existing Keychain mapping (`KEYCHAIN_MAPPINGS` in `src/config/secrets.ts`) keeps
working; a blank placeholder cannot shadow it. Set
`DAILY_INTELLIGENCE_SECRETS_FILE` to keep the file somewhere else.

## What never happens

- No value reaches a log, event, attempt record or run artifact. Startup records
  how many names were set and which are still blank, never a value.
- No credential reaches an agent session. Collectors and the research layer run
  server-side and hand the agent content, never keys.
- No value is passed as a command-line argument, so it appears in no process
  list or shell history.
- `.env` holds database settings only and is gitignored. `pnpm setup:check`
  prints which names are configured, never their values.

The code and tests behind each of these are listed in
[`SECURITY.md`](SECURITY.md#secrets).
