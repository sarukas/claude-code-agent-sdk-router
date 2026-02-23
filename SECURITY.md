# Security Model

This document describes the security architecture and how it differs from the upstream projects.

## Transport security

### Normal flow (no proxy)

```
Claude Code / Agent SDK
    -> HTTPS (TLS 1.2/1.3) -> api.anthropic.com
    <- HTTPS <-
```

Traffic is encrypted end-to-end via TLS. API keys are sent in the `x-api-key` header, encrypted in transit. Certificate validation ensures the client is talking to Anthropic's servers.

### With ccasr (standard or gateway mode)

```
Claude Code / Agent SDK
    -> HTTP (plaintext) -> 127.0.0.1 (ccasr)
    -> HTTPS (TLS) -> provider API
    <- HTTPS <-
    <- HTTP <-
```

**The localhost leg is unencrypted.** API keys, request bodies, and responses travel in plaintext between Claude Code and ccasr. The outbound leg to the provider API is always HTTPS (except Ollama, which is also localhost).

### Why the plaintext localhost leg is acceptable

1. **Localhost never touches the network.** Traffic to `127.0.0.1` stays inside the OS kernel's loopback interface. It never hits a NIC, never leaves the machine, and cannot be sniffed from another host on the LAN.

2. **Binding to `127.0.0.1` only.** ccasr refuses to bind to `0.0.0.0`. No external machine can connect to the proxy. There is no config option to change this.

3. **Same-machine trust boundary.** If an attacker can read your loopback traffic, they already have access to your filesystem (where API keys are stored) and process memory. The plaintext HTTP adds no incremental risk.

4. **This is Anthropic's intended design.** `ANTHROPIC_BASE_URL` is an official configuration point for local proxies. There is no certificate pinning, no mutual TLS, and no response signature verification in the SDK.

### Gateway mode passthrough

In gateway mode with passthrough auth, the provider's API key travels:

```
SDK subprocess env (ANTHROPIC_API_KEY=sk-or-v1-...)
    -> x-api-key header over HTTP to localhost ccasr
    -> Authorization header over HTTPS to provider
```

The key is in plaintext on the localhost hop but encrypted on the outbound hop. The in-memory session map (which remembers provider,model per API key) holds keys in memory only — never written to disk, cleared on gateway shutdown.

### If you need the localhost leg encrypted

Run ccasr behind a local TLS terminator (e.g., `mkcert` + nginx/caddy on localhost with a self-signed CA). This is overkill for single-machine use but could matter in non-standard deployments.

## Threat model

This proxy sits between Claude Code (a local CLI tool) and remote LLM APIs. It handles API keys and routes requests. The primary threats are:

1. **Code injection** — malicious input causing arbitrary code execution on the proxy host
2. **Config injection** — external sources modifying routing or API keys
3. **Dependency supply chain** — compromised npm packages executing in the proxy process
4. **Network exposure** — the proxy being accessible from outside localhost
5. **Credential leakage** — API keys written to logs or disk unintentionally

### What ccasr protects against

| Threat | Protected? | How |
|--------|-----------|-----|
| Network eavesdropping (remote) | Yes | Localhost binding + outbound HTTPS |
| Provider impersonation | Yes | Outbound requests use HTTPS with standard cert validation |
| Dynamic code injection | Yes | Static import registry, no eval/vm/dynamic require |
| Plugin/agent code execution | Yes | Plugin and agent systems completely removed |
| Remote config injection | Yes | No CDN calls, no preset fetching, no remote registry |
| Dependency supply chain | Mitigated | 6 pinned runtime deps, lockfile committed |

### What ccasr does NOT protect against

| Threat | Protected? | Why |
|--------|-----------|-----|
| Local process snooping | No | Any local process with sufficient privileges can read loopback traffic or process memory |
| Env var tampering | No | If an attacker controls your environment variables, the trust boundary is already broken |
| API key leakage to disk | Partial | Keys are never written to log files in gateway mode; in standard mode, only when `LOG: true` enables payload capture |
| Filesystem access to config | Partial | Config file should have restrictive permissions (`chmod 600`); ccasr does not enforce this |

## How we mitigate each threat

### No dynamic code loading

The original codebase used `require()` with user-specified file paths to load transformer modules at runtime. This project replaces that with a **static TypeScript import registry** (`src/core/transformers/registry.ts`).

Every transformer is a static import. The set of providers is fixed at compile time. There is no mechanism to load code from a file path, URL, or string.

**Banned patterns** (verified by `npm run audit:security`):
- `vm.runInContext` / `vm.createContext`
- `require()` with variable paths
- `new Function()`
- `eval()`

**Note**: `require('undici')` in `src/router.ts` is the sole exception — it lazy-loads the undici package for HTTP proxy support (`PROXY_URL`). This is a known npm package, not a user-specified path.

### No plugin or agent system

The original claude-code-router includes:
- A plugin system (`CCRPlugin.register()`) that executes arbitrary code on request lifecycle hooks
- An agent system (`IAgent.shouldHandle()`) that injects tools and rewrites streams

Both are **completely removed**. There are no lifecycle hooks, no tool injection points, and no stream rewriting beyond the fixed transformer chain.

### No remote config or registry fetching

The original fetches a provider registry from Cloudflare R2 CDN at startup and supports installing "presets" from GitHub. This project:
- Loads config from **one local file only**: `~/.ccasr/config.json` (standard mode) or no file at all (gateway mode)
- Makes **zero network calls** at startup (only when forwarding user requests to providers)
- Has no preset system, no CDN calls, no remote registry

### Pinned dependencies

All runtime dependencies are pinned to **exact versions** (no `^`, no `~`). `package-lock.json` is committed to the repository.

| Runtime dep | Version | Purpose |
|-------------|---------|---------|
| fastify | 5.7.4 | HTTP server |
| pino | 9.6.0 | Structured logging (fastify peer dep) |
| pino-roll | 4.0.0 | Log file rotation |
| json5 | 2.2.3 | Config parsing (allows comments) |
| jsonrepair | 3.12.0 | Safe JSON repair for tool arguments |
| undici | 7.10.0 | HTTP proxy support (ProxyAgent, lazy-loaded) |

The original llms package has 11 runtime deps; the original CCR server adds more. We use 6.

### Localhost binding

The server binds to `127.0.0.1` only — never `0.0.0.0`. It is not accessible from the network. There is no option to change this in config (standard mode). In gateway mode, the `host` option defaults to `127.0.0.1`.

### No background daemon

The proxy runs in the foreground only (`ccasr start`, `ccasr run`, or `ccasr gateway`). No PID files, no systemd integration, no auto-start on login. The user explicitly starts and stops the process. `ccasr run` spawns the proxy as part of the same process — it is not a detached daemon.

### Credential handling by mode

| Aspect | Standard mode | Gateway mode |
|--------|--------------|--------------|
| Key storage | Config file on disk | In-memory only (per-request passthrough or credential store with TTL) |
| Key in logs | Only when `LOG: true` | Never (payload capture disabled) |
| Key in env | `$ENV_VAR` interpolation at startup | Passed per-subprocess via `ANTHROPIC_API_KEY` |
| Key lifetime | Until config file is changed | Per-request (passthrough) or TTL-bounded (credential store, max 24h) |
| File logging | On by default | Off by default |

### Proxy authentication (gateway mode)

Gateway mode supports an optional `proxySecret` (`--secret` flag). When set, every request must include `x-api-key: <secret>` for proxy authentication. This is **mutually exclusive** with passthrough mode — if `proxySecret` is set, the `x-api-key` header cannot also carry the provider key.

Without `proxySecret`, passthrough mode is active and the localhost binding is the sole security boundary. This is the recommended configuration for same-machine Agent SDK deployments.

## Verification commands

Run these before any release or after any change:

```bash
# Must return zero results — no dynamic code execution patterns
grep -rn 'vm\.runInContext\|vm\.createContext\|new Function(' src/

# Must return zero results — no deleted system references
grep -rn 'plugin\|agent\|preset\|cdnUrl\|providerRegistry' src/

# Transformer imports should only exist in registry.ts
grep -rn 'import.*Transformer' src/core/ | grep -v 'registry.ts'
# ^ should be empty

# Count total lines of code
find src/ -name '*.ts' | xargs wc -l | tail -1
```

## Reporting vulnerabilities

If you find a security issue, please open a GitHub issue or contact the maintainer directly. This is a small project — there is no formal security disclosure process.
