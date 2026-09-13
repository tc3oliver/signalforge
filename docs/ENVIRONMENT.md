# Environment — verified, not assumed

Everything here was read off this machine on 2026-09-13. Nothing was taken from a
tutorial or a changelog.

## Toolchain

| Thing | Value | How it was checked |
|---|---|---|
| Pi | 0.85.1 | `pi --version` |
| Node | v24.21.0 | `node --version`, mise-managed |
| pnpm | 10.34.5 | `pnpm --version`, mise-managed |
| `pi` binary | `~/.local/share/mise/installs/node/24/bin/pi` | `which pi` |

## Pi packages actually installed

| Package | Version |
|---|---|
| `@earendil-works/pi-coding-agent` | 0.85.1 |
| `@earendil-works/pi-ai` | 0.85.1 (transitive) |
| `typebox` | 1.3.7 (transitive) |

`pi-ai` and `typebox` ship inside `pi-coding-agent`'s own `node_modules` via
npm-shrinkwrap. This project therefore depends on `@earendil-works/pi-coding-agent`
and `typebox` directly and takes Pi's `Model` type from the runtime API rather
than importing `@earendil-works/pi-ai`, which does not resolve from here.

**The TypeBox package is `typebox`, not `@sinclair/typebox`.** Custom tool
parameters use `import { Type } from "typebox"`.

## Model IDs — confirmed present

Read from `pi --list-models` on this machine. All three resolve through
`ModelRuntime.getModel()` in the restricted runtime:

| Role | Provider | Model | Context | Max out |
|---|---|---|---|---|
| Primary | `github-copilot` | `gemini-3.8-flash` | 1M | 64K |
| Fallback 1 | `openai-codex` | `gpt-5.6-sol` | 272K | 128K |
| Fallback 2 | `opencode-go` | `deepseek-v4.1-flash` | 1M | 384K |

Note the dots: `gemini-3.8-flash`, not `gemini-3-8-flash`; `deepseek-v4.1-flash`,
not `deepseek-v4-flash` (which is a different, also-present model).

## SDK facts this project depends on

Read from the installed `dist/*.d.ts`, `docs/sdk.md` and `examples/sdk/`, not from
the public docs site.

- `createAgentSession({ noTools: "all", customTools, tools })` yields a session whose
  active tool set is exactly the custom tools. Verified: `getActiveToolNames()`
  returns our 11 names and nothing else.
- A `ResourceLoader` supplied explicitly replaces ALL discovery — global extensions
  (`pi-web-access`, `pi-usage`), `AGENTS.md` walking, prompt templates and themes.
- `SettingsManager.inMemory()` means the global `~/.pi/agent/settings.json` is
  neither read nor written.
- `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })` reuses the
  existing OAuth logins. **`refreshOnCreate` must be `true`** or the cached catalog
  in `models-store.json` is not restored and `deepseek-v4.1-flash` fails to resolve
  (only statically-bundled models survive). `allowModelNetwork: false` still keeps it
  off the network, and the global `models-store.json` is verified byte-identical
  after a run.
- **Pi's skill mechanism is lazy and needs a file-read tool.**
  `buildSystemPrompt` only appends `formatSkillsForPrompt(...)` when `read` or
  `bash` is among the active tools, because the advertisement tells the model to open
  `SKILL.md` itself. A restricted runtime has neither, so Pi's own path is inert here.
  See `docs/ARCHITECTURE.md` for how this project keeps a real Pi skill anyway.
- Tools signal rejection by **throwing**; `AgentToolResult` has no `isError` field.
  `terminate: true` on a result asks the agent loop to stop after the batch.

## What was deliberately NOT touched

`~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`, `~/.config/pi/`, the Keychain,
the globally installed `pi-web-access` and `@narumitw/pi-usage`. No Pi extension was
installed for this project, and no third-party package was patched.
