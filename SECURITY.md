# Security Model

This document describes the security architecture and how it differs from the upstream projects.

## Threat model

This proxy sits between Claude Code (a local CLI tool) and remote LLM APIs. It handles API keys and routes requests. The primary threats are:

1. **Code injection** — malicious input causing arbitrary code execution on the proxy host
2. **Config injection** — external sources modifying routing or API keys
3. **Dependency supply chain** — compromised npm packages executing in the proxy process
4. **Network exposure** — the proxy being accessible from outside localhost

## How we mitigate each

### No dynamic code loading

The original codebase used `require()` with user-specified file paths to load transformer modules at runtime. This project replaces that with a **static TypeScript import registry** (`src/core/transformers/registry.ts`).

Every transformer is a static import. The set of providers is fixed at compile time. There is no mechanism to load code from a file path, URL, or string.

**Banned patterns** (verified by `npm run audit:security`):
- `vm.runInContext` / `vm.createContext`
- `require()` with variable paths
- `new Function()`
- `eval()`

### No plugin or agent system

The original claude-code-router includes:
- A plugin system (`CCRPlugin.register()`) that executes arbitrary code on request lifecycle hooks
- An agent system (`IAgent.shouldHandle()`) that injects tools and rewrites streams

Both are **completely removed**. There are no lifecycle hooks, no tool injection points, and no stream rewriting beyond the fixed transformer chain.

### No remote config or registry fetching

The original fetches a provider registry from Cloudflare R2 CDN at startup and supports installing "presets" from GitHub. This project:
- Loads config from **one local file only**: `~/.config/ccr-minimal/config.json`
- Makes **zero network calls** at startup (only when forwarding user requests to providers)
- Has no preset system, no CDN calls, no remote registry

### Pinned dependencies

All 5 runtime dependencies and 3 dev dependencies are pinned to **exact versions** (no `^`, no `~`). `package-lock.json` is committed to the repository.

| Runtime dep | Version | Purpose |
|-------------|---------|---------|
| fastify | 5.3.2 | HTTP server |
| @fastify/cors | 11.0.1 | CORS headers |
| pino | 9.6.0 | Structured logging |
| json5 | 2.2.3 | Config parsing (allows comments) |
| jsonrepair | 3.12.0 | Safe JSON repair for tool arguments |

The original llms package has 11 runtime deps; the original CCR server adds 11 more. We use 5.

### Localhost binding

The server binds to `127.0.0.1` only — never `0.0.0.0`. It is not accessible from the network. There is no option to change this in config.

### No APIKEY gate

The original CCR has an APIKEY field that gates access to the proxy. We remove it. The security model is simpler: the proxy is localhost-only, and the config file should have restrictive filesystem permissions (`chmod 600`).

### No background daemon

The proxy runs in the foreground only. No PID files, no systemd integration, no auto-start on login. The user explicitly starts and stops the process.

## Verification commands

Run these before any release or after any change:

```bash
# Must return zero results — no dynamic code execution patterns
grep -rn 'vm\.runInContext\|vm\.createContext\|require(.*path\|new Function(' src/

# Must return zero results — no deleted system references
grep -rn 'plugin\|agent\|preset\|cdnUrl\|providerRegistry' src/

# Transformer imports should only exist in registry.ts
grep -rn 'import.*Transformer' src/core/ | grep -v 'registry.ts'
# ↑ should be empty

# Count total lines of code
find src/ -name '*.ts' | xargs wc -l | tail -1
# ↑ target: ≤ 1,500
```

## Reporting vulnerabilities

If you find a security issue, please open a GitHub issue or contact the maintainer directly. This is a small project — there is no formal security disclosure process.
