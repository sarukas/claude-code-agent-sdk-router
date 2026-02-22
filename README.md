# claude-code-agent-sdk-router

A minimal, auditable API proxy that routes Claude Code and Agent SDK requests to any of 7 LLM providers.

**Anthropic** · **OpenRouter** · **Gemini** · **OpenAI** · **Groq** · **Mistral** · **Ollama**

---

## Why this exists

Claude Code speaks the Anthropic `/v1/messages` API. This proxy intercepts those calls and routes them to whichever provider you configure — letting you use Claude Code's tooling with Gemini, OpenAI, open-source models via Groq, or fully-offline models via Ollama.

This project is a security-focused rewrite inspired by [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) and its core library [musistudio/llms](https://github.com/musistudio/llms). While those projects pioneered the approach, this fork diverges significantly with a focus on **auditability, minimal attack surface, and pinned dependencies**.

## Design principles

- **Fully auditable** — ~2,000 lines of TypeScript. One developer can read the entire codebase in an afternoon.
- **No dynamic code loading** — zero `require()` of external files, no `vm` module, no plugin hooks, no agent injection. All provider wiring uses static TypeScript imports.
- **Minimal dependencies** — 5 runtime deps (fastify, @fastify/cors, pino, json5, jsonrepair). Every version pinned exactly. `package-lock.json` committed.
- **Localhost only** — binds to `127.0.0.1`, never `0.0.0.0`. No network exposure by default.
- **No background daemon** — runs in the foreground. No PID files, no auto-start, no persistent process without explicit user action.
- **No UI** — configuration is a single JSON file with comments.

## What was removed vs. the original

| Removed | Reason |
|---------|--------|
| Plugin system (`CCRPlugin`) | Arbitrary code execution surface |
| Agent system (`IAgent`, tool injection) | Arbitrary code execution surface |
| Preset marketplace / CDN fetching | Remote code/config injection risk |
| Custom router scripts (`require()`) | Dynamic code loading |
| Web UI (React package) | Unnecessary complexity |
| Token counting / tiktoken | Not needed for routing |
| Background daemon / service management | Attack surface reduction |
| Provider registry CDN | Network dependency at startup |
| 16+ transformer files | Only 3 kept + 4 new minimal ones written |

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

## Quick start

```bash
# Clone and install
git clone https://github.com/sarukas/claude-code-agent-sdk-router.git
cd claude-code-agent-sdk-router
npm install

# Copy and edit config
mkdir -p ~/.ccasr
cp config.example.json ~/.ccasr/config.json
# Edit config.json — add your API keys

# Run in development
npm run dev

# Or build and run
npm run build
npm start
```

Then point Claude Code at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_API_KEY=any-non-empty-string
```

## Configuration

Config lives at `~/.ccasr/config.json` (JSON5 — comments allowed).

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

  // Route Claude Code requests to providers
  "Router": {
    "default": "anthropic,claude-sonnet-4-20250514",
    "background": "groq,llama-3.3-70b-versatile"
  }
}
```

### Config rules

- **`Providers[].name`** — must be exactly one of: `anthropic`, `openrouter`, `gemini`, `openai`, `groq`, `mistral`, `ollama`
- **`api_key`** — literal string or `$ENV_VAR` reference (interpolated at startup, never logged)
- **`Router.*`** — format: `"providerName,modelName"` (split on first comma)
- **`Router.default`** — required. `Router.background` is optional (falls back to default)

## CLI

```
ccasr start     # Start proxy server (foreground, Ctrl-C to stop)
ccasr version   # Print version and Node version
ccasr help      # Print usage instructions
```

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/messages` | Main routing endpoint — accepts Anthropic format, routes to configured provider |
| `GET` | `/health` | Health check — returns status, version, configured providers |

That's it. Two endpoints. Nothing else.

## Architecture

```
Claude Code  ──▶  POST /v1/messages  ──▶  Router
                                            │
                    ┌───────────────────────┤
                    ▼                       ▼
              TransformerIn          TransformerOut
              (Anthropic → unified)  (unified → provider)
                                            │
                                            ▼
                                     Provider API
                                            │
                                            ▼
                                     TransformerIn
                                     (provider → unified)
                                            │
                                            ▼
                                     TransformerOut
                                     (unified → Anthropic)
                                            │
                                            ▼
                                     Claude Code
```

Each provider has a transformer that converts between the Anthropic format Claude Code speaks and the provider's native format, using an OpenAI-compatible intermediate representation.

## Security model

See [SECURITY.md](SECURITY.md) for the full security analysis and verification commands.

## Acknowledgments

This project is inspired by and builds upon the work of [musistudio](https://github.com/musistudio):
- [claude-code-router](https://github.com/musistudio/claude-code-router) — the original Claude Code routing proxy
- [llms](https://github.com/musistudio/llms) — the universal LLM API transformation library

Both are MIT licensed. This project diverges significantly in architecture, with a focus on security hardening, auditability, and minimal attack surface. The transformer logic for Anthropic, Gemini, and OpenRouter draws from the llms library; all other code is new.

## License

[MIT](LICENSE)
