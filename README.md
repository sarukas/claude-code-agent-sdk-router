# claude-code-agent-sdk-router

A minimal, auditable API proxy that routes Claude Code and Agent SDK requests to any of 7 LLM providers.

**Anthropic** · **OpenRouter** · **Gemini** · **OpenAI** · **Groq** · **Mistral** · **Ollama**

---

## Prerequisites

- **Node.js >= 18.20** (uses native `fetch`)
- API key(s) for at least one provider (or Ollama running locally)

## Quick start

```bash
# 1. Clone, install, and make the ccasr command available
git clone https://github.com/sarukas/claude-code-agent-sdk-router.git
cd claude-code-agent-sdk-router
npm install
npm run build && npm link

# 2. Run the interactive setup wizard
ccasr setup
#    Walks you through: provider selection, API keys, named route sets
#    Writes config to ~/.ccasr/config.json

# 3. Launch Claude Code through the proxy
ccasr run claude
#    Starts the proxy on 127.0.0.1:3456, sets ANTHROPIC_BASE_URL and
#    ANTHROPIC_API_KEY in claude's environment, shuts down when claude exits
```

That's it. Claude Code now routes through your configured providers.

### Alternative: run without installing

If you don't want to install globally, use `npx tsx` to run from source directly:

```bash
git clone https://github.com/sarukas/claude-code-agent-sdk-router.git
cd claude-code-agent-sdk-router
npm install

npx tsx src/cli.ts setup
npx tsx src/cli.ts run claude
```

### Alternative: manual config

If you prefer to configure by hand instead of using the wizard:

```bash
mkdir -p ~/.ccasr
cp config.example.json ~/.ccasr/config.json
# Edit ~/.ccasr/config.json — set your API keys and route sets

ccasr start
# In another terminal, point Claude Code at the proxy:
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_API_KEY=ccasr-proxy
claude
```

## CLI

| Command | Description |
|---------|-------------|
| `ccasr setup` | Interactive setup wizard — creates or edits `~/.ccasr/config.json` |
| `ccasr start` | Start the proxy server (foreground, Ctrl-C to stop) |
| `ccasr run <command>` | Start proxy + launch command (e.g. `ccasr run claude`) |
| `ccasr version` | Print version and Node version |
| `ccasr help` | Show usage instructions |

All commands accept `--config <path>` to use an alternative config file and `--route <name>` to override the active route set:

```bash
ccasr start --route mixed           # use "mixed" route set
ccasr run --route cheap claude      # proxy with "cheap" routes
ccasr start --config ./test.json    # alternative config file
```

Without a global install, prefix with `npx tsx src/cli.ts` instead of `ccasr`.

### `ccasr setup`

Interactive, menu-driven configuration editor. On first run it walks you through provider selection, API keys, a named route set, and port sequentially. On subsequent runs it loads your existing config and drops you into the main menu:

```
  Current configuration:

    Providers:    Anthropic ($ANTHROPIC_API_KEY), Gemini ($GEMINI_API_KEY)
    Active route: direct
    Port:         3456
    Logging:      OFF
    Route "direct" *:
      sonnet: anthropic / claude-sonnet-4-20250514
      haiku:  gemini / gemini-2.5-flash

  Setup menu:
  > Edit providers
    Edit API keys
    Edit route sets
    Edit port
    Toggle detailed logging
    Save and exit
    Exit without saving
```

**Edit route sets** opens a sub-menu where you can:
- Edit an existing route set's tier assignments
- Add a new named route set
- Remove a route set (cannot remove the active one)
- Set which route set is active by default

All changes are held in memory until you choose **Save and exit** — nothing is written until then. API keys are masked in the summary (`$ENV_VAR` shown as-is, raw keys as `sk...7x2f`).

Model choices come from `known_models.json` at the project root. Edit that file to add or reorder models.

### `ccasr run`

Starts the proxy server, injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` into the child process environment, then launches the given command with `stdio: 'inherit'` (full TTY passthrough). When the child exits, the proxy shuts down and the process exits with the child's exit code.

```bash
ccasr run claude                    # launch Claude Code
ccasr run --route mixed claude      # launch with a different route set
ccasr run claude --model opus       # launch with flags
```

## Configuration

Config lives at `~/.ccasr/config.json` (JSON5 — comments allowed). Created automatically by `ccasr setup`, or copy from `config.example.json`.

```json5
{
  "LOG": false,
  "API_TIMEOUT_MS": 300000,
  "PORT": 3456,

  // Providers — just credentials. Base URLs are built-in defaults.
  // Use "$ENV_VAR" to reference environment variables.
  "Providers": {
    "anthropic": "$ANTHROPIC_API_KEY",
    "openrouter": "$OPENROUTER_API_KEY",
    "gemini": "$GEMINI_API_KEY"
  },

  // Named route sets — different model mixes for different scenarios.
  // Each tier: "providerName,modelName" (split on first comma).
  "Routes": {
    "direct": {
      "opus":   "anthropic,claude-opus-4-20250514",
      "sonnet": "anthropic,claude-sonnet-4-20250514",
      "haiku":  "anthropic,claude-haiku-4-5-20241022"
    },
    "mixed": {
      "sonnet": "openrouter,google/gemini-2.5-pro-preview",
      "haiku":  "gemini,gemini-2.5-flash"
    },
    "cheap": {
      "sonnet": "gemini,gemini-2.5-flash",
      "haiku":  "gemini,gemini-2.5-flash"
    }
  },

  // Which route set to use by default. Override with --route flag.
  "ActiveRoute": "direct"
}
```

### Config rules

- **`Providers`** — object mapping provider name to API key. Provider names must be one of: `anthropic`, `openrouter`, `gemini`, `openai`, `groq`, `mistral`, `ollama`. Base URLs are built-in defaults (no need to specify them).
- **`api_key`** — literal string or `$ENV_VAR` reference (interpolated at startup, never logged)
- **`Routes`** — object of named route sets. Each route set has `sonnet` (required), and optionally `opus` and `haiku`. Values are `"providerName,modelName"` format (split on first comma).
- **`ActiveRoute`** — which route set to use at runtime. Can be overridden with `--route <name>`.
- **Backward compat** — old config format with `Providers` array and single `Router` object is auto-detected and works without changes.

### Named route sets

Route sets let you define different model mixes and switch between them without editing config:

| Route set | Use case | Example |
|-----------|----------|---------|
| `direct` | Full Anthropic, maximum quality | All tiers use Anthropic models |
| `mixed` | Balance cost and quality | Sonnet via OpenRouter, Haiku via Gemini |
| `cheap` | Minimize cost for development | Everything through Gemini Flash |

Switch at runtime with `--route`:

```bash
ccasr start --route cheap           # develop cheaply
ccasr run --route direct claude     # switch to full Anthropic for important work
npm test -- --route mixed           # test the "mixed" route set
```

The `ActiveRoute` field in config sets the default when `--route` is not specified.

### Model routing

Claude Code sends Anthropic model names (e.g. `claude-sonnet-4-20250514`). The proxy classifies the incoming model into a tier and routes it to the configured provider and model for that tier:

| Tier | Matches model names containing | Use case |
|------|-------------------------------|----------|
| `opus` | `opus` | Powerful tasks |
| `sonnet` | `sonnet` (or unrecognized) | Primary workhorse, default fallback |
| `haiku` | `haiku` | Fast/cheap tasks, subagents |

If a tier is not configured, it falls back to `sonnet`. The proxy replaces **both** the provider and the model name — so if sonnet maps to `"openai,gpt-4.1"`, the request reaches OpenAI with `model: "gpt-4.1"`.

Explicit `"provider,model"` prefix in requests (used by the test runner) bypasses tier routing entirely.

## Supported providers

| Provider | Type | Use case |
|----------|------|----------|
| **Anthropic** | Native pass-through | Route back to Anthropic API directly |
| **OpenRouter** | OpenAI-compatible | Access many models through one API |
| **Gemini** | Custom format | Google's models with tool call translation |
| **OpenAI** | Native format | GPT-4o, GPT-4.1, etc. |
| **Groq** | OpenAI-compatible | Fast Llama/Mixtral inference |
| **Mistral** | OpenAI-compatible | Codestral and Mistral models |
| **Ollama** | OpenAI-compatible | Fully offline local models |

These 7 providers are hard-wired. No others can be added without modifying source code. This is intentional.

## Logging

Logs are written to `~/.ccasr/logs/ccasr.log` with automatic rotation (default: rotate at 10MB, keep 5 files). Console output is always active.

| Config key | Default | Description |
|------------|---------|-------------|
| `LOG` | `false` | Enable debug-level logging (request bodies to console) |
| `LOG_FILE` | `true` | Write logs to `~/.ccasr/logs/ccasr.log` |
| `LOG_MAX_SIZE` | `"10m"` | Rotate log file at this size |
| `LOG_MAX_FILES` | `5` | Number of rotated files to keep |

Set `"LOG_FILE": false` to disable file logging entirely.

## Testing

The test suite exercises providers through the running proxy. Tests derive their targets from the active route set — only providers and models referenced in the active route are tested.

```bash
# Start the proxy first
npm run dev

# In a separate terminal, run all tests (uses ActiveRoute from config)
npm test

# Test a specific route set
npm test -- --route mixed

# Run a specific test
npm test -- --route direct streaming
```

Tests are config-aware: the runner reads your config, resolves the active route set, and runs provider tests per unique provider and SDK tests per tier. Results are written to `~/.ccasr/logs/test-results.json`.

### Test suites

- **Provider tests** (5 tests per unique provider in the route): basic_query, tool_use, streaming, invalid_model, web_search
- **Agent SDK tests** (8 tests per tier in the route): basic format, streaming SSE, multi-turn tool calls, web search/fetch, subagent patterns, long tool list selection

See [TESTING.md](TESTING.md) for the full testing guide — test descriptions, CLI usage, debugging tips, and how to add new tests.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/messages` | Main routing endpoint — accepts Anthropic format, routes to configured provider |
| `GET` | `/health` | Health check — returns status, version, providers, active route |

That's it. Two endpoints. Nothing else.

## Architecture

```
Claude Code  -->  POST /v1/messages  -->  Router
                                            |
                    +-----------------------+
                    v                       v
              TransformerIn          TransformerOut
              (Anthropic -> unified)  (unified -> provider)
                                            |
                                            v
                                     Provider API
                                            |
                                            v
                                     TransformerIn
                                     (provider -> unified)
                                            |
                                            v
                                     TransformerOut
                                     (unified -> Anthropic)
                                            |
                                            v
                                     Claude Code
```

Each provider has a transformer that converts between the Anthropic format Claude Code speaks and the provider's native format, using an OpenAI-compatible intermediate representation.

## Why this exists

Claude Code speaks the Anthropic `/v1/messages` API. This proxy intercepts those calls and routes them to whichever provider you configure — letting you use Claude Code's tooling with Gemini, OpenAI, open-source models via Groq, or fully-offline models via Ollama.

This project is a security-focused rewrite inspired by [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) and its core library [musistudio/llms](https://github.com/musistudio/llms). While those projects pioneered the approach, this fork diverges significantly with a focus on **auditability, minimal attack surface, and pinned dependencies**.

## Design principles

- **Fully auditable** — ~2,000 lines of TypeScript. One developer can read the entire codebase in an afternoon.
- **No dynamic code loading** — zero `require()` of external files, no `vm` module, no plugin hooks, no agent injection. All provider wiring uses static TypeScript imports.
- **Minimal dependencies** — 6 runtime deps (fastify, @fastify/cors, pino, pino-roll, json5, jsonrepair). Every version pinned exactly. `package-lock.json` committed.
- **Localhost only** — binds to `127.0.0.1`, never `0.0.0.0`. No network exposure by default.
- **No background daemon** — runs in the foreground. No PID files, no auto-start, no persistent process without explicit user action.
- **No UI** — configuration is a single JSON file with comments.

## Security model

See [SECURITY.md](SECURITY.md) for the full security analysis and verification commands.

## Acknowledgments

This project is inspired by and builds upon the work of [musistudio](https://github.com/musistudio):
- [claude-code-router](https://github.com/musistudio/claude-code-router) — the original Claude Code routing proxy
- [llms](https://github.com/musistudio/llms) — the universal LLM API transformation library

Both are MIT licensed. This project diverges significantly in architecture, with a focus on security hardening, auditability, and minimal attack surface. The transformer logic for Anthropic, Gemini, and OpenRouter draws from the llms library; all other code is new.

## License

[MIT](LICENSE)
