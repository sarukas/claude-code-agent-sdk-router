# Integration Spec: Multi-Instance Agent SDK with ccasr Gateway

## The Problem

An application (e.g., a SaaS backend) needs to run **N concurrent Claude Agent SDK sessions**, each potentially targeting a different provider, model, and API key. The Agent SDK's `ClaudeSDKClient` spawns `claude` binary as a subprocess — no custom HTTP headers can be injected. The only controls are environment variables set before spawn:

| Env var | What claude.exe does with it |
|---------|------------------------------|
| `ANTHROPIC_BASE_URL` | Base URL for all API calls |
| `ANTHROPIC_API_KEY` | Sent as `x-api-key` header |
| `ANTHROPIC_AUTH_TOKEN` | Sent as `Authorization: Bearer` header (alternative) |
| `ANTHROPIC_MODEL` | Sent as `model` field in request body |

These are set per-subprocess at spawn time and are immutable for the lifetime of that session.

## Architecture

```
+-----------------------------------------------------+
|                   Application Backend                |
|                                                      |
|  +----------+  +----------+       +----------+      |
|  | Session 1 |  | Session 2 |  ... | Session N |     |
|  |           |  |           |      |           |     |
|  | env:      |  | env:      |      | env:      |     |
|  |  KEY=sk-a |  |  KEY=sk-b |      |  KEY=sk-c |     |
|  |  MODEL=   |  |  MODEL=   |      |  MODEL=   |     |
|  |  or,gem.. |  |  gem,fl.. |      |  oai,4.1  |     |
|  +-----+-----+  +-----+-----+      +-----+-----+     |
|        |              |                   |           |
|        +--------------+-------------------+           |
|                       v                               |
|              ccasr gateway (:8901)                    |
|              (single shared instance)                 |
|                       |                               |
+-----------------------+-------------------------------+
                        |
          +-------------+-------------+
          v             v             v
     OpenRouter      Gemini        OpenAI
```

**One ccasr gateway, many SDK subprocesses.** Each subprocess carries its own provider key and target model in its environment. ccasr is stateless — it reads the provider from the model field and the API key from the `x-api-key` header on every request independently.

## Model Tier Fallback

Claude Code internally switches model tiers — it may send `claude-haiku-4-5-20241022` for subagents or `claude-opus-4-20250514` for complex tasks, even when `ANTHROPIC_MODEL` is set to a specific value. These bare model names (without a `provider,` prefix) would normally fail in gateway mode since there are no route sets to resolve them.

**How ccasr handles this:** The gateway maintains a per-session map (keyed by `x-api-key` header) that remembers the provider and model from the first explicit `"provider,model"` request. All subsequent bare model names from the same session fall back to that same provider and model.

```
Session timeline (ANTHROPIC_MODEL=openrouter,google/gemini-2.5-flash):

  Request 1: model="openrouter,google/gemini-2.5-flash"
             -> routes to OpenRouter / gemini-2.5-flash
             -> session map records: sk-or-v1-... -> {openrouter, gemini-2.5-flash}

  Request 2: model="claude-haiku-4-5-20241022"  (bare — subagent)
             -> looks up sk-or-v1-... in session map
             -> routes to OpenRouter / gemini-2.5-flash (fallback)

  Request 3: model="claude-opus-4-20250514"  (bare — complex task)
             -> looks up sk-or-v1-... in session map
             -> routes to OpenRouter / gemini-2.5-flash (fallback)
```

**This means all tiers go to the same model.** This is suboptimal (haiku tasks run on the same model as sonnet tasks) but ensures nothing breaks. The alternative — rejecting bare model names — would cause Claude Code subagents to fail.

**Requirements:**
- The first request in a session MUST use `"provider,model"` format. Bare model names before any explicit request return a 400 error.
- Session identity is based on the `x-api-key` header, which is unique per subprocess (since each subprocess has its own `ANTHROPIC_API_KEY`).
- The session map is in-memory and resets on gateway restart.

## Concurrency Model

The Agent SDK spawns `claude.exe` with a **snapshot** of the environment at spawn time (`subprocess_cli.py:346-351`):

```python
process_env = {
    **os.environ,
    **self._options.env,
    "CLAUDE_CODE_ENTRYPOINT": "sdk-py",
}
```

The `env` dict passed via `ClaudeAgentOptions` overrides `os.environ`. Once the subprocess starts, its environment is frozen — mutations to `os.environ` in the parent don't affect running subprocesses.

This means **no global lock is needed** if you pass credentials via `ClaudeAgentOptions.env` rather than mutating `os.environ`:

```python
# SAFE — each session gets its own env snapshot, no lock needed
client = ClaudeSDKClient(ClaudeAgentOptions(
    env={
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{gateway_port}",
        "ANTHROPIC_API_KEY": provider_api_key,
        "ANTHROPIC_MODEL": f"{provider},{model}",
    },
    # ... other options
))
```

If instead you mutate `os.environ` directly (because some code path reads from it), you need a lock around the mutation+spawn window — but the lock scope is just "set env vars -> spawn subprocess", not the entire session lifetime.

## Implementation

### 1. Gateway lifecycle manager

```python
# ccasr_gateway.py

import asyncio
import httpx
import shutil
import subprocess
import signal
from pathlib import Path

class CcasrGateway:
    """Manages a single ccasr gateway process shared across all SDK sessions."""

    def __init__(self, port: int = 0):
        self._requested_port = port
        self._process: subprocess.Popen | None = None
        self._port: int | None = None

    async def start(self) -> int:
        """Start the gateway, return the bound port."""
        ccasr_bin = shutil.which("ccasr")
        if not ccasr_bin:
            # Fallback: run from source
            ccasr_bin = "npx"
            args = [ccasr_bin, "tsx", "src/cli.ts", "gateway"]
        else:
            args = [ccasr_bin, "gateway"]

        if self._requested_port:
            args.extend(["--port", str(self._requested_port)])

        self._process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        # Wait for gateway to be ready by polling /health
        self._port = self._requested_port or await self._discover_port()
        await self._wait_healthy(timeout=10.0)
        return self._port

    async def _discover_port(self) -> int:
        """Read the port from gateway stdout (prints 'Listening: http://127.0.0.1:PORT')."""
        assert self._process and self._process.stdout
        for line in self._process.stdout:
            if "Listening:" in line:
                # Parse "http://127.0.0.1:PORT"
                port_str = line.strip().split(":")[-1]
                return int(port_str)
        raise RuntimeError("Gateway did not print listening address")

    async def _wait_healthy(self, timeout: float) -> None:
        """Poll /health until gateway responds."""
        deadline = asyncio.get_event_loop().time() + timeout
        async with httpx.AsyncClient() as client:
            while asyncio.get_event_loop().time() < deadline:
                try:
                    r = await client.get(f"http://127.0.0.1:{self._port}/health")
                    if r.status_code == 200 and r.json().get("mode") == "gateway":
                        return
                except httpx.ConnectError:
                    pass
                await asyncio.sleep(0.1)
        raise RuntimeError(f"Gateway not healthy after {timeout}s")

    @property
    def port(self) -> int:
        assert self._port, "Gateway not started"
        return self._port

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def stop(self) -> None:
        if self._process:
            self._process.send_signal(signal.SIGTERM)
            self._process.wait(timeout=5)
            self._process = None
            self._port = None
```

### 2. SDK session factory

```python
# sdk_session.py

from claude_sdk import ClaudeSDKClient, ClaudeAgentOptions

class SDKSessionFactory:
    """Creates Agent SDK sessions routed through ccasr gateway."""

    def __init__(self, gateway_base_url: str):
        self._gateway_url = gateway_base_url

    def create_session(
        self,
        provider: str,
        model: str,
        api_key: str,
        *,
        max_turns: int = 25,
        system_prompt: str | None = None,
        # ... other ClaudeAgentOptions fields
    ) -> ClaudeSDKClient:
        """
        Create an SDK session targeting a specific provider and model.

        Args:
            provider: One of: anthropic, openrouter, gemini, openai, groq, mistral, ollama
            model: Provider-specific model ID (e.g., "google/gemini-2.5-flash")
            api_key: The provider's API key (forwarded via passthrough auth)
        """
        return ClaudeSDKClient(ClaudeAgentOptions(
            env={
                "ANTHROPIC_BASE_URL": self._gateway_url,
                "ANTHROPIC_API_KEY": api_key,
                "ANTHROPIC_MODEL": f"{provider},{model}",
            },
            max_turns=max_turns,
            system_prompt=system_prompt or "",
        ))
```

### 3. Running concurrent sessions

```python
# worker_pool.py

import asyncio
from ccasr_gateway import CcasrGateway
from sdk_session import SDKSessionFactory

async def run_concurrent_sessions():
    # 1. Start one shared gateway
    gateway = CcasrGateway(port=8901)
    port = await gateway.start()
    factory = SDKSessionFactory(gateway.base_url)

    # 2. Define workloads — each can use a different provider/model/key
    workloads = [
        {
            "provider": "openrouter",
            "model": "google/gemini-2.5-flash",
            "api_key": "sk-or-v1-user1-key...",
            "prompt": "Analyze this codebase for security issues",
        },
        {
            "provider": "gemini",
            "model": "gemini-2.5-pro",
            "api_key": "AIza-user2-key...",
            "prompt": "Write unit tests for auth module",
        },
        {
            "provider": "openai",
            "model": "gpt-4.1",
            "api_key": "sk-user3-key...",
            "prompt": "Refactor the database layer",
        },
        {
            "provider": "groq",
            "model": "llama-3.3-70b-versatile",
            "api_key": "gsk_user4-key...",
            "prompt": "Summarize recent changes",
        },
    ]

    # 3. Launch all sessions concurrently
    async def run_one(workload: dict) -> str:
        client = factory.create_session(
            provider=workload["provider"],
            model=workload["model"],
            api_key=workload["api_key"],
        )
        async with client:
            result = await client.process_query(workload["prompt"])
            return result.text

    results = await asyncio.gather(
        *[run_one(w) for w in workloads],
        return_exceptions=True,
    )

    for workload, result in zip(workloads, results):
        provider = workload["provider"]
        if isinstance(result, Exception):
            print(f"[{provider}] ERROR: {result}")
        else:
            print(f"[{provider}] OK: {result[:100]}...")

    # 4. Shutdown
    await gateway.stop()
```

## Why This Works Without Locks

| Concern | Resolution |
|---------|------------|
| Env var races | Each SDK session passes env via `ClaudeAgentOptions.env`, creating an isolated snapshot at subprocess spawn. No shared mutable state. |
| Credential isolation | Each `claude.exe` process has its own `ANTHROPIC_API_KEY` baked into its environment. Process A's key never leaks to process B. |
| ccasr concurrency | Fastify handles concurrent HTTP requests natively. Each request carries its own `x-api-key` and `model` field — no shared state in ccasr. |
| Provider mixing | Session 1 can use OpenRouter while session 2 uses Gemini simultaneously. ccasr resolves the provider per-request from the model field. |
| Model tier fallback | Each session's bare model names resolve to that session's own provider,model via the session map (keyed by `x-api-key`). No cross-session leakage. |

## If You MUST Use `os.environ` Mutation

Some code paths may require setting `os.environ` directly (e.g., libraries that read env vars internally before you can intercept). In that case, scope the lock to mutation+spawn only:

```python
import asyncio
import os

_env_lock = asyncio.Lock()

async def create_session_with_env_lock(
    gateway_url: str,
    provider: str,
    model: str,
    api_key: str,
) -> ClaudeSDKClient:
    async with _env_lock:
        # Set env vars — lock ensures no other coroutine reads stale values
        os.environ["ANTHROPIC_BASE_URL"] = gateway_url
        os.environ["ANTHROPIC_API_KEY"] = api_key
        os.environ["ANTHROPIC_MODEL"] = f"{provider},{model}"

        # Spawn — subprocess captures env snapshot at this moment
        client = ClaudeSDKClient(ClaudeAgentOptions())
        await client.__aenter__()  # triggers subprocess spawn

    # Lock released — env vars can now be changed by other coroutines.
    # The subprocess already has its snapshot.
    return client
```

The lock window is ~milliseconds (env set + process spawn). It does **not** block for the duration of the SDK session.

## Multi-Tenant with Per-User Credentials

For a SaaS app where each user has their own API keys stored in a database:

```python
async def handle_user_query(user_id: str, query: str, workspace: dict):
    """Handle a query for a specific user with their own credentials."""
    # 1. Load user's credentials from database
    provider = workspace["provider"]        # e.g., "openrouter"
    model = workspace["model"]              # e.g., "google/gemini-2.5-flash"
    api_key = await decrypt_api_key(        # e.g., "sk-or-v1-..."
        user_id, workspace["encrypted_key"]
    )

    # 2. Create isolated SDK session
    client = factory.create_session(
        provider=provider,
        model=model,
        api_key=api_key,
    )

    # 3. Run — fully isolated from other users' sessions
    async with client:
        result = await client.process_query(query)
        return result.text
```

Key properties:
- User A's API key never appears in User B's subprocess environment
- Each user can target a different provider and model
- If User A's key is revoked/invalid, only their session gets a 401 — others are unaffected
- ccasr never stores the API key — it passes through on each request and is discarded

## Error Handling

```python
async def run_with_retry(factory: SDKSessionFactory, workload: dict) -> str:
    """Run an SDK session with error categorization."""
    client = factory.create_session(
        provider=workload["provider"],
        model=workload["model"],
        api_key=workload["api_key"],
    )
    try:
        async with client:
            result = await client.process_query(workload["prompt"])
            return result.text
    except Exception as e:
        error_msg = str(e)
        if "401" in error_msg:
            # Bad API key — don't retry, notify user
            raise ValueError(
                f"Invalid API key for {workload['provider']}. "
                "Check your credentials."
            ) from e
        if "400" in error_msg and "provider,model" in error_msg:
            # Bad model format — programming error
            raise ValueError(
                f"Invalid model format. Use 'provider,model' syntax."
            ) from e
        if "429" in error_msg or "rate" in error_msg.lower():
            # Rate limited — retry with backoff
            await asyncio.sleep(5)
            return await run_with_retry(factory, workload)
        raise  # Unknown error — propagate
```

## Scaling Limits

| Factor | Limit | Notes |
|--------|-------|-------|
| Concurrent sessions | ~100s per gateway | Fastify handles thousands of concurrent connections. Bottleneck is provider rate limits, not ccasr. |
| Memory per session | ~50-80MB | Each `claude.exe` subprocess. This is the Agent SDK's footprint, not ccasr's. |
| ccasr memory | ~30MB base | Fastify + Node.js overhead. Negligible per-request overhead since gateway is stateless. |
| Provider rate limits | Varies | OpenRouter: ~200 req/min free tier. Gemini: 60 req/min. These are the real bottleneck. |
| Gateway instances | 1 per backend | Single gateway handles all sessions. Scale horizontally by running multiple backends, each with its own gateway. |

## Verification Checklist

1. Start gateway: `ccasr gateway --port 8901`
2. Verify health: `curl http://127.0.0.1:8901/health` -> `mode: "gateway"`
3. Single session test: create one SDK session, verify query completes
4. Concurrent test: launch 4 sessions with different providers simultaneously
5. Credential isolation: verify session A's key doesn't appear in session B's error messages
6. Error propagation: send request with invalid key -> verify 401 reaches the SDK client
7. Model tier fallback: send a bare `claude-haiku-4-5-20241022` after an explicit `provider,model` request -> verify it routes to the same provider,model
8. Gateway restart: stop gateway, restart, verify new sessions work (old sessions will fail — expected, they should reconnect or be recreated)
