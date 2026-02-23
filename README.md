# claude-code-agent-sdk-router

A minimal, auditable API proxy that routes Claude Code and Agent SDK requests to any of 7 LLM providers.

**Anthropic** · **OpenRouter** · **Gemini** · **OpenAI** · **Groq** · **Mistral** · **Ollama**

---
## Why this exists

I built a large AI application on top of Anthropic Agent SDK when there were very few Agent SDKs around. As the application matured, I realized how deeply locked in this made me to Anthropic and it's ecosystem. 
Don't get me wrong - Agent SDK is amazing - it is the core of Claude Code. It is very good. But, I needed options. Hence, this router. 
It works both for Agent SDK and for Claude Code. My main focus was a good model swap-out solution for the Agent SDK. Claude Code routing came along as a bonus. 
Both work surprisingly well. It is also super weird to see Codex or Gemini run within Claude's clothes :-). You can see how these models stack up against each other back to back by giving the same task to several Claude sessions easily. Seeing how they do 
their work differently in the same wrapper is eye-opening. 

This local Claude Code router also has very comprehensive logging of full traffic, to help you debug and also understand how tools like Claude or Agent SDK work 
under the hood. You can inspect system prompts, tool call details and all the little tricks that make modern AI feel real. 

## What it does

Claude Code and the Anthropic Agent SDK speak the Anthropic `/v1/messages` API. This proxy intercepts those calls and routes them to whichever provider you configure — letting you use Claude Code's tooling with Gemini, OpenAI, open-source models via Groq, or fully-offline models via Ollama.

Each provider has a transformer that converts between the Anthropic format and the provider's native format, using an OpenAI-compatible intermediate representation.

## Two modes of operation

| Mode | Use case | Config | Credentials | Model routing |
|------|----------|--------|-------------|---------------|
| **Standard** (`ccasr start` / `ccasr run`) | Single user running Claude Code locally | `~/.ccasr/config.json` | From config file | Tier-based (opus/sonnet/haiku) via named route sets |
| **Gateway** (`ccasr gateway` / `createGateway()`) | Multi-tenant Agent SDK applications | None required | Per-request (passthrough or header) | Explicit `"provider,model"` format with session fallback |

## Prerequisites

- **Node.js >= 18.20** (uses native `fetch`)
- API key(s) for at least one provider (or Ollama running locally)

## Installation

```bash
git clone https://github.com/sarukas/claude-code-agent-sdk-router.git
cd claude-code-agent-sdk-router
npm install && npm run build && npm link
```

This installs dependencies, compiles TypeScript to `dist/`, and symlinks the `ccasr` command globally.

To update:

```bash
cd claude-code-agent-sdk-router
git pull && npm install && npm run build
```

To uninstall:

```bash
npm uninstall -g claude-code-agent-sdk-router
```

Without a global install, prefix commands with `npx tsx src/cli.ts` instead of `ccasr`.

## CLI

| Command | Description |
|---------|-------------|
| `ccasr setup` | Interactive setup wizard — creates or edits `~/.ccasr/config.json` |
| `ccasr start` | Start the proxy server (foreground, Ctrl-C to stop) |
| `ccasr run <command>` | Start proxy + launch command (e.g. `ccasr run claude`) |
| `ccasr gateway` | Start in gateway mode — no config file, per-request credentials |
| `ccasr version` | Print version and Node version |
| `ccasr help` | Show usage instructions |

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

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/messages` | Main routing endpoint — accepts Anthropic format, routes to configured provider |
| `GET` | `/health` | Health check — returns status, version, providers, mode |
| `POST` | `/v1/credentials` | Register a credential with TTL (gateway mode only) |
| `DELETE` | `/v1/credentials/:id` | Revoke a credential (gateway mode only) |

---

# Standard Mode

For single-user Claude Code usage with a config file.

## Quick start

```bash
# 1. Run the interactive setup wizard
ccasr setup
#    Walks you through: provider selection, API keys, named route sets
#    Writes config to ~/.ccasr/config.json

# 2. Launch Claude Code through the proxy
ccasr run claude
#    Starts the proxy on 127.0.0.1:3456, sets ANTHROPIC_BASE_URL and
#    ANTHROPIC_API_KEY in claude's environment, shuts down when claude exits
```

That's it. Claude Code now routes through your configured providers.

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
```

All commands accept `--config <path>` to use an alternative config file and `--route <name>` to override the active route set.

### Model routing

Claude Code sends Anthropic model names (e.g. `claude-sonnet-4-20250514`). The proxy classifies the incoming model into a tier and routes it to the configured provider and model for that tier:

| Tier | Matches model names containing | Use case |
|------|-------------------------------|----------|
| `opus` | `opus` | Powerful tasks |
| `sonnet` | `sonnet` (or unrecognized) | Primary workhorse, default fallback |
| `haiku` | `haiku` | Fast/cheap tasks, subagents |

If a tier is not configured, it falls back to `sonnet`. The proxy replaces **both** the provider and the model name — so if sonnet maps to `"openai,gpt-4.1"`, the request reaches OpenAI with `model: "gpt-4.1"`.

Explicit `"provider,model"` prefix in requests (used by the test runner) bypasses tier routing entirely.

## `ccasr setup`

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

## `ccasr run`

Starts the proxy server, injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` into the child process environment, then launches the given command with `stdio: 'inherit'` (full TTY passthrough). When the child exits, the proxy shuts down and the process exits with the child's exit code.

```bash
ccasr run claude                    # launch Claude Code
ccasr run --route mixed claude      # launch with a different route set
ccasr run claude --model opus       # launch with flags
```

## Logging (standard mode)

Logs are written to `~/.ccasr/logs/ccasr.log` with automatic rotation (default: rotate at 10MB, keep 5 files). Console output is always active.

| Config key | Default | Description |
|------------|---------|-------------|
| `LOG` | `false` | Enable debug-level logging (request bodies to console) |
| `LOG_FILE` | `true` | Write logs to `~/.ccasr/logs/ccasr.log` |
| `LOG_MAX_SIZE` | `"10m"` | Rotate log file at this size |
| `LOG_MAX_FILES` | `5` | Number of rotated files to keep |

Set `"LOG_FILE": false` to disable file logging entirely.

---

# Gateway Mode

For multi-tenant Agent SDK applications. No config file required — all routing and credentials are per-request.

## Why gateway mode?

The Claude Agent SDK spawns `claude.exe` as a subprocess. The subprocess reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from its environment and makes HTTP requests with only standard headers (`x-api-key` or `Authorization: Bearer`). There is no mechanism to inject custom HTTP headers.

Gateway mode solves this with **passthrough authentication**: the incoming `x-api-key` header (set by `ANTHROPIC_API_KEY`) IS the provider's actual API key. ccasr extracts the target provider from the model field and forwards the key to that provider.

## Quick start

```bash
# Start the gateway
ccasr gateway --port 8901
```

Then configure your Agent SDK application:

```python
import os

# Point the SDK at ccasr
os.environ["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:8901"

# The API key IS the provider key — ccasr forwards it to the target provider
os.environ["ANTHROPIC_API_KEY"] = orchestration.openrouter_api_key  # e.g., "sk-or-v1-..."

# Model field specifies provider + model (split on first comma)
os.environ["ANTHROPIC_MODEL"] = "openrouter,google/gemini-2.5-flash"
```

That's it. The SDK sends requests to ccasr, which:
1. Extracts `openrouter` as the provider and `google/gemini-2.5-flash` as the model
2. Uses the incoming `x-api-key` (`sk-or-v1-...`) as the OpenRouter API key
3. Converts Anthropic format to OpenAI format, sends to OpenRouter
4. Converts the response back to Anthropic format, returns to the SDK

## Model field format

The primary routing mechanism uses `"provider,model"` format:

| Provider | Model field |
|----------|-------------|
| Anthropic | `anthropic,claude-sonnet-4-20250514` |
| OpenRouter | `openrouter,google/gemini-2.5-flash` |
| Gemini | `gemini,gemini-2.5-flash` |
| OpenAI | `openai,gpt-4.1` |
| Groq | `groq,llama-3.3-70b-versatile` |
| Mistral | `mistral,codestral-latest` |
| Ollama | `ollama,qwen2.5-coder:latest` |

## Model tier fallback

Claude Code internally switches model tiers — it may send `claude-haiku-4-5-20241022` for subagents or `claude-opus-4-20250514` for complex tasks, even when `ANTHROPIC_MODEL` is set to a different value. In standard mode, these bare model names are classified into tiers and resolved via the config's route sets.

In gateway mode, there are no route sets. Instead, **bare model names fall back to the same provider and model as the session's main `"provider,model"` request.** The gateway remembers the provider,model from the first explicit `"provider,model"` request per session (keyed by `x-api-key` header), and routes all subsequent bare model names to the same destination.

Example: if `ANTHROPIC_MODEL=openrouter,google/gemini-2.5-flash`, then:
- `model: "openrouter,google/gemini-2.5-flash"` — routes to OpenRouter / gemini-2.5-flash (and remembers this)
- `model: "claude-haiku-4-5-20241022"` — also routes to OpenRouter / gemini-2.5-flash (fallback)
- `model: "claude-opus-4-20250514"` — also routes to OpenRouter / gemini-2.5-flash (fallback)

This means all tiers go to the same model, which is suboptimal but ensures nothing breaks. The first request in a session must use `"provider,model"` format — bare model names before any explicit request return a 400 error.

## Credential resolution

| Priority | Source | When to use |
|----------|--------|-------------|
| 1 | `X-Provider-Api-Key` header | Raw SDK clients that can set custom headers |
| 2 | `X-Credential-Id` header | Multi-tenant apps using the credential store |
| 3 | Passthrough (`x-api-key` / `Authorization: Bearer`) | Agent SDK — the only option since custom headers can't be injected |
| 4 | Pre-configured key (from `createGateway({ providers })`) | Single-tenant deployments with known keys |
| 5 | 401 error | No key found |

Passthrough (priority 3) is only active when `proxySecret` is NOT set — these are mutually exclusive. Localhost binding is the security boundary.

## Credential store (optional)

For applications that can make HTTP calls but can't set custom headers on SDK requests (e.g., a backend that manages multiple user sessions):

```bash
# Register a credential with TTL
curl -X POST http://127.0.0.1:8901/v1/credentials \
  -H 'Content-Type: application/json' \
  -d '{"provider": "openrouter", "api_key": "sk-or-v1-...", "ttl_seconds": 3600}'
# -> {"credential_id": "cred_a1b2c3...", "expires_in_seconds": 3600}

# Use it on requests (for clients that CAN set custom headers)
curl -X POST http://127.0.0.1:8901/v1/messages \
  -H 'X-Credential-Id: cred_a1b2c3...' \
  -H 'Content-Type: application/json' \
  -d '{"model": "openrouter,google/gemini-2.5-flash", "max_tokens": 100, "messages": [...]}'

# Revoke early
curl -X DELETE http://127.0.0.1:8901/v1/credentials/cred_a1b2c3...
```

Credentials auto-expire after TTL (default 1 hour, max 24 hours).

## Library usage (programmatic)

```typescript
import { createGateway } from 'claude-code-agent-sdk-router';

const gw = await createGateway({
  port: 8901,                    // default: 0 (OS-assigned)
  host: '127.0.0.1',            // default: 127.0.0.1
  logToConsole: true,            // default: true
  timeoutMs: 300000,             // default: 300s
  providers: {                   // optional: pre-configure keys
    openrouter: 'sk-or-...',
    gemini: '$GEMINI_API_KEY',   // env var interpolation works
  },
  providerUrls: {                // optional: override base URLs
    ollama: 'http://gpu-server:11434/v1/chat/completions',
  },
});

const { port } = gw.address();
console.log(`Gateway on port ${port}`);

// Graceful shutdown
await gw.close();
```

## Proxy authentication

If you need to restrict access to the gateway (e.g., it's not on localhost):

```bash
ccasr gateway --port 8901 --secret my-proxy-token
```

When `--secret` is set, every request must include `x-api-key: my-proxy-token`. However, this means the `x-api-key` header is consumed for proxy auth and **cannot** also carry the provider key — use `X-Provider-Api-Key` header or the credential store instead. Passthrough mode is disabled.

## Logging (gateway mode)

Gateway mode intentionally minimizes logging to protect multi-tenant credential and payload privacy:

| Log type | Standard mode | Gateway mode | Why |
|----------|--------------|--------------|-----|
| Fastify request/response lines | Console + file | Console only | Basic HTTP status logging, no sensitive data |
| 4-point payload capture (`claude_in`/`provider_out`/`provider_in`/`claude_out`) | When `LOG: true` | Disabled | Full request/response bodies would leak user credentials and content |
| File logging (`~/.ccasr/logs/`) | On by default | Off by default | No disk writes of potentially sensitive multi-tenant data |

- **Console logging** (`logToConsole`): On by default. Shows Fastify request/response status lines (method, URL, status code, latency). No request bodies or API keys.
- **Payload capture**: Always disabled in gateway mode. The `CaptureLogger` is never created — all capture blocks in `router.ts` are skipped.
- **File logging** (`logToFile`): Off by default. Can be enabled via `createGateway({ logToFile: true })` but this is not recommended for multi-tenant deployments.

To silence all output: `createGateway({ logToConsole: false })`.

## Health endpoint

```bash
curl http://127.0.0.1:8901/health
```

```json
{
  "status": "ok",
  "mode": "gateway",
  "providers": ["anthropic", "openrouter", "gemini", "openai", "groq", "mistral", "ollama"],
  "transformers": ["anthropic", "openrouter", "gemini", "openai", "groq", "mistral", "ollama"],
  "features": {
    "per_request_credentials": true,
    "credential_store": true,
    "passthrough_auth": true,
    "streaming": true,
    "image_conversion": true,
    "thinking_support": true
  }
}
```

## Multi-instance Agent SDK integration

For running multiple concurrent SDK sessions through a single gateway, see [INTEGRATION.md](INTEGRATION.md) — covers gateway lifecycle management, session factory pattern, concurrency model, and per-user credential isolation.

---

# Reference

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
