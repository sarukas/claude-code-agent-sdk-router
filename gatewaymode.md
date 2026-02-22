# Specification: ccasr Gateway Mode for Agent SDK Integration

## Context

Applications use the Claude Agent SDK to execute LLM queries. When routing through non-Anthropic providers (via OpenRouter, Gemini, etc.), format mismatches break images, tool calls, thinking, and streaming. The `ccasr` router already solves these with a proven transformer pipeline, but its current architecture is CLI/config-file driven — designed for a single user running Claude Code locally.

Applications that use Anthropic Agent SDK  needs ccasr to work as a **multi-tenant, per-request-routed, format-converting gateway** where:

- Each workspace can target a different provider/model
- Each user has their own API credentials (stored encrypted in SQLite)
- Model selection is per-conversation (frozen at creation time)
- The gateway is stateless — all routing/auth info comes from the request

## What ccasr Already Has (Reusable)

- **Transformer pipeline**: Anthropic ↔ Unified (OpenAI) ↔ Provider-native format conversion
- **7 provider transformers**: Anthropic, OpenRouter, Gemini, OpenAI, Groq, Mistral, Ollama
- **Streaming state machines**: SSE conversion for all providers
- **Image handling**: Claude `image` blocks ↔ `image_url` data URLs
- **Thinking/reasoning**: Budget mapping, signature handling, provider-specific formats
- **Tool call normalization**: ID generation, argument parsing, JSON repair
- **`"provider,model"` routing**: PreHandler already parses `"openrouter,google/gemini-2.5-flash"` from the model field

## What ccasr Needs: Gateway Mode

A new operational mode (`ccasr gateway` or `createGateway()`) that makes ccasr stateless and integration-friendly.

### 1. Per-Request Credential Passing

**Current:** Credentials loaded from `~/.ccasr/config.json` at startup, resolved once.
**Needed:** Credentials passed per-request via headers, forwarded to the target provider.

**Proposed headers:**

```
X-Provider-Api-Key: sk-or-v1-abc123...    # API key for the target provider
X-Provider-Name: openrouter               # Target provider (optional if using "provider,model" format)
X-Provider-Model: google/gemini-2.5-flash # Target model (optional if using "provider,model" format)
```

**Behavior:**

- If `X-Provider-Api-Key` is present → use it for the target provider (ignore config-stored key)
- If absent → fall back to config-stored key (backward compatible)
- The incoming `x-api-key` or `Authorization` header from the SDK client is **not forwarded** to the provider (it's just the proxy auth token)

**Implementation:** In `router.ts`, after provider resolution, check for `X-Provider-Api-Key` header and override `provider.api_key` for that request.

### 2. Explicit Provider+Model Routing via Model Field

**Current:** Already works! PreHandler in `server.ts` (lines 92-112) parses `"provider,model"` from `request.body.model`.
**Enhancement:** Make this the primary routing mechanism in gateway mode (no tier-based fallback needed).

**Applications that use Anthropic Agent SDK sets:**

```python
os.environ["ANTHROPIC_MODEL"] = "openrouter,google/gemini-2.5-flash"
```

SDK sends request with `model: "openrouter,google/gemini-2.5-flash"` → ccasr extracts provider=`openrouter`, model=`google/gemini-2.5-flash`.

**No changes needed** — this already works.

### 3. Gateway Server Factory (Library Mode)

**Current:** `createServer(configPath?, activeRoute?, opts?)` requires a config file path.
**Needed:** Programmatic instantiation with no file dependency.

**New export from `src/index.ts`:**

```typescript
import { createGateway } from 'ccasr';

const gateway = await createGateway({
  port: 8901,                    // default: 0 (OS-assigned)
  host: '127.0.0.1',            // default: 127.0.0.1
  logToFile: false,              // default: false in gateway mode
  logToConsole: true,            // default: true
  timeoutMs: 300000,             // default: 300s
  providers: {                   // optional: pre-configure provider credentials
    openrouter: 'sk-or-...',     // or omit to require per-request credentials
    gemini: '$GEMINI_API_KEY',   // env var interpolation still works
  },
  providerUrls: {                // optional: override default base URLs
    ollama: 'http://gpu-server:11434/v1/chat/completions',
  },
});

const { port } = gateway.address(); // actual bound port
await gateway.close();               // graceful shutdown
```

**Implementation:** Factor `createServer()` to accept an inline config object alongside (or instead of) a file path. The gateway factory is a thin wrapper that creates a minimal `AppConfig` and passes it through.

### 4. No Config File Required

**Current:** Config file is mandatory — `ConfigService` constructor throws if file missing.
**Needed:** In gateway mode, config is optional. All provider base URLs have sensible defaults (already hardcoded in `ConfigService`).

**Implementation:** Make `ConfigService` accept an optional inline config object. If no file path AND no inline config → use defaults (all providers available, no stored credentials, no routes).

### 5. Proxy Authentication (Optional)

For security, the gateway should optionally validate that incoming requests are from an authorized caller.

**Proposed:** Optional `proxySecret` in gateway config:

```typescript
const gateway = await createGateway({
  proxySecret: 'my-secret-token',  // if set, requests must have x-api-key: my-secret-token
});
```

If `proxySecret` is set, the PreHandler validates the incoming `x-api-key` header matches before routing. If not set (default), all localhost requests are accepted.

### 6. Health Endpoint Enhancement

**Current:** `GET /health` returns version, active route, provider names.
**Needed:** Also return available transformers and their capabilities:

```json
{
  "status": "ok",
  "version": "1.2.0",
  "mode": "gateway",
  "transformers": ["anthropic", "openrouter", "gemini", "openai", "groq", "mistral", "ollama"],
  "features": {
    "per_request_credentials": true,
    "provider_model_routing": true,
    "streaming": true,
    "image_conversion": true,
    "thinking_support": true
  }
}
```

---

## Integration Architecture (Applications that use Anthropic Agent SDK  Side)

With gateway mode, Applications that use Anthropic Agent SDK 's integration becomes clean:

### SDK Changes (`e.g. worker.py`)

```python
# Current OpenRouter mode:
os.environ["ANTHROPIC_BASE_URL"] = "https://openrouter.ai/api"
os.environ["ANTHROPIC_AUTH_TOKEN"] = orchestration.openrouter_api_key

# New ccasr gateway mode:
os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{ccasr_port}"
os.environ["ANTHROPIC_API_KEY"] = "ccasr-proxy"  # proxy auth (or proxySecret)
os.environ["ANTHROPIC_MODEL"] = f"{provider},{model}"  # e.g., "openrouter,google/gemini-2.5-flash"
```

The per-request credential passing uses a **custom SDK hook** or **header injection**. Since the Claude SDK sets `x-api-key` from `ANTHROPIC_API_KEY`, we need the provider's actual API key to reach ccasr via a different channel.

### Credential Passing Options

**Option A — Environment variable convention:**

```python
os.environ["CCASR_PROVIDER_API_KEY"] = orchestration.openrouter_api_key
```

ccasr reads `CCASR_PROVIDER_API_KEY` from its own environment on each request (since it runs as a subprocess of the backend, it inherits the env). But this doesn't work for concurrent multi-user requests.

**Option B — Custom header via SDK hook:**
The Claude Agent SDK supports `PreToolUse` hooks but not raw HTTP header injection. However, since ccasr is localhost, we can use a simpler approach:

**Option C — Credential registration endpoint (cleanest):**
Add a lightweight endpoint to ccasr:

```
POST /v1/credentials
{
  "provider": "openrouter",
  "api_key": "sk-or-v1-...",
  "ttl_seconds": 3600
}
→ { "credential_id": "cred_abc123" }
```

Then pass the credential ID via a header:

```
X-Credential-Id: cred_abc123
```

This keeps credentials out of environment variables and supports concurrent multi-user requests. Credentials auto-expire after TTL.

**Option D — Sideband credential file (simplest):**
Before each SDK query, Applications that use Anthropic Agent SDK writes the provider API key to a temp file:

```python
cred_path = f"/tmp/ccasr-creds/{request_id}.key"
Path(cred_path).write_text(orchestration.openrouter_api_key)
os.environ["CCASR_CREDENTIAL_FILE"] = cred_path
```

ccasr reads the file path from the `X-Credential-File` header or env var, uses the key, and deletes the file. Simple but depends on filesystem.

### Recommended: Option C (Credential Registration)

It's the cleanest because:

- No filesystem coupling
- Supports concurrent multi-user requests naturally
- Credentials have TTL (auto-cleanup)
- Simple HTTP API
- Credential ID is a small string that can be passed via headers

---

## Summary of ccasr Changes

| Change                                                    | Scope                                  | Effort  |
| --------------------------------------------------------- | -------------------------------------- | ------- |
| Gateway mode factory (`createGateway()`)                  | `src/index.ts`, `src/core/server.ts`   | Small   |
| Inline config support (no file required)                  | `src/core/services/config.ts`          | Small   |
| Per-request credential header (`X-Provider-Api-Key`)      | `src/router.ts`                        | Small   |
| Credential registration endpoint (`POST /v1/credentials`) | New route in `src/core/api/routes.ts`  | Medium  |
| Credential store (in-memory Map with TTL)                 | New `src/core/services/credentials.ts` | Small   |
| Proxy authentication (`proxySecret`)                      | `src/core/server.ts` PreHandler        | Small   |
| Enhanced health endpoint                                  | `src/core/api/routes.ts`               | Trivial |
| Export library entry point                                | `src/index.ts`, `package.json`         | Small   |
| `ccasr gateway` CLI command                               | `src/cli.ts`                           | Small   |

**Total estimated scope:** ~300-400 lines of new code across 6-8 files. No changes to existing transformers.

## Summary of Applications that use Anthropic Agent SDK  Changes

| Change                                       | Scope in Applications that use Anthropic Agent SDK | Effort  |
| -------------------------------------------- | -------------------------------------------------- | ------- |
| ccasr process manager (start/stop/health)    | New `ccasr_manager.py`                             | Medium  |
| Worker pool routing through ccasr            | `sdkapp/app/domain/agent/sdk_workers/worker.py`    | Small   |
| Credential registration before each query    | Worker pool calls `POST /v1/credentials`           | Small   |
| Backend startup/shutdown hooks               | `sdkapp/app/main.py`                               | Small   |
| Configuration (enable/disable ccasr gateway) | Settings or env var                                | Trivial |

## Verification

1. Start ccasr in gateway mode: `ccasr gateway --port 8901`
2. Register a credential: `POST /v1/credentials` with OpenRouter API key
3. Send Anthropic-format request with `model: "openrouter,google/gemini-2.5-flash"` and `X-Credential-Id` header
4. Verify response comes back in Anthropic format with correct content
5. Test with image content blocks — verify format conversion works
6. Test streaming — verify SSE events are correctly transformed
7. Test concurrent requests with different credentials — verify isolation
8. Integration: Start Applications that use Anthropic Agent SDK backend with ccasr gateway, send a query through the frontend, verify end-to-end flow
