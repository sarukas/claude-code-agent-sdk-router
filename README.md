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
#    Walks you through: provider selection, API keys, router model tiers
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
# Edit ~/.ccasr/config.json — set your API keys and Router tiers

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

Without a global install, prefix with `npx tsx src/cli.ts` instead of `ccasr`:

```bash
npx tsx src/cli.ts setup
npx tsx src/cli.ts run claude
npx tsx src/cli.ts start
```

The CLI auto-detects how it was invoked and prints the correct command prefix in help and setup output.

### `ccasr setup`

Interactive, menu-driven configuration editor. On first run it walks you through provider selection, API keys, model routing, and port sequentially. On subsequent runs it loads your existing config and drops you into the main menu:

```
  Current configuration:

    Providers:  Anthropic ($ANTHROPIC_API_KEY), Gemini ($GEMINI_API_KEY)
    Sonnet:     anthropic / claude-sonnet-4-20250514
    Opus:       (not configured)
    Haiku:      gemini / gemini-2.5-flash
    Port:       3456

  Setup menu:
  > Edit providers
    Edit API keys
    Edit model routing
    Edit port
    Save and exit
    Exit without saving
```

All changes are held in memory until you choose **Save and exit** — nothing is written until then. API keys are masked in the summary (`$ENV_VAR` shown as-is, raw keys as `sk...7x2f`).

Model choices come from `known_models.json` at the project root. Edit that file to add or reorder models.

### `ccasr run`

Starts the proxy server, injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` into the child process environment, then launches the given command with `stdio: 'inherit'` (full TTY passthrough). When the child exits, the proxy shuts down and the process exits with the child's exit code.

```bash
ccasr run claude                    # launch Claude Code
ccasr run claude --model opus       # launch with flags
ccasr run echo hello                # any command works
```

## Configuration

Config lives at `~/.ccasr/config.json` (JSON5 — comments allowed). Created automatically by `ccasr setup`, or copy from `config.example.json`.

```json5
{
  // Emit request/response bodies to stdout (keep false in production)
  "LOG": false,
  "API_TIMEOUT_MS": 300000,
  "PORT": 3456,

  "Providers": [
    {
      "name": "anthropic",
      "api_base_url": "https://api.anthropic.com",
      "api_key": "$ANTHROPIC_API_KEY"
    },
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "$OPENROUTER_API_KEY",
      "models": ["google/gemini-2.5-pro-preview", "anthropic/claude-sonnet-4"]
    },
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_key": "$GEMINI_API_KEY",
      "models": ["gemini-2.5-flash", "gemini-2.5-pro"]
    },
    {
      "name": "openai",
      "api_base_url": "https://api.openai.com/v1/chat/completions",
      "api_key": "$OPENAI_API_KEY",
      "models": ["gpt-4o", "gpt-4.1"]
    },
    {
      "name": "groq",
      "api_base_url": "https://api.groq.com/openai/v1/chat/completions",
      "api_key": "$GROQ_API_KEY",
      "models": ["llama-3.3-70b-versatile"]
    },
    {
      "name": "mistral",
      "api_base_url": "https://api.mistral.ai/v1/chat/completions",
      "api_key": "$MISTRAL_API_KEY",
      "models": ["codestral-latest", "mistral-large-latest"]
    },
    {
      "name": "ollama",
      "api_base_url": "http://localhost:11434/v1/chat/completions",
      "api_key": "ollama",
      "models": ["qwen2.5-coder:latest"]
    }
  ],

  // Route Claude Code requests by model tier
  "Router": {
    "opus":   "openrouter,google/gemini-2.5-pro-preview",
    "sonnet": "anthropic,claude-sonnet-4-20250514",
    "haiku":  "groq,llama-3.3-70b-versatile"
  }
}
```

### Config rules

- **`Providers[].name`** — must be exactly one of: `anthropic`, `openrouter`, `gemini`, `openai`, `groq`, `mistral`, `ollama`
- **`api_key`** — literal string or `$ENV_VAR` reference (interpolated at startup, never logged)
- **`Router.*`** — format: `"providerName,modelName"` (split on first comma)
- **`Router.sonnet`** — required. `Router.opus` and `Router.haiku` are optional (fall back to sonnet)
- Backward compat: `Router.default` is silently migrated to `Router.sonnet`

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

The test suite exercises every configured provider through the running proxy.

```bash
# Start the proxy first
npm run dev

# In a separate terminal, run all tests
npm test

# Run tests for a specific provider
npx tsx tests/runner.ts http://127.0.0.1:3456 openai

# Run a specific test across all providers
npx tsx tests/runner.ts http://127.0.0.1:3456 "" basic_query
```

Tests are config-aware: only providers present in `~/.ccasr/config.json` are tested. Results are written to `~/.ccasr/logs/test-results.json`.

### Test suites

- **Provider tests** (5 tests per provider): basic_query, tool_use, streaming, invalid_model, web_search
- **Agent SDK tests** (8 tests): basic format, streaming SSE, multi-turn tool calls, web search/fetch, subagent patterns, long tool list selection

See [TESTING.md](TESTING.md) for the full testing guide — test descriptions, CLI usage, debugging tips, and how to add new tests.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/messages` | Main routing endpoint — accepts Anthropic format, routes to configured provider |
| `GET` | `/health` | Health check — returns status, version, configured providers |

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
