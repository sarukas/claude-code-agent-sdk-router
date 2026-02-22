# Architecture Plan & Implementation Spec  —  v1.0

## Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Repo scaffold, LICENSE, README, SECURITY.md, directory structure | DONE |
| 2 | Inline core transformers (Anthropic, Gemini, OpenRouter) from llms | TODO |
| 3 | Simplify services (Config, Provider, Transformer, Server) | TODO |
| 4 | Routes, CLI, entry point, router logic | TODO |
| 5a | New transformers (OpenAI, Groq, Mistral, Ollama) + shared utility | TODO |
| 5b | End-to-end verification against all 7 providers | TODO |
| 6 | Dependency lock, npm audit, security verification | TODO |
| 7 | Final docs, code review, LOC count | TODO |

## Source repos (cloned locally for reference)
- `C:\Users\sarunas\AppData\Local\Temp\musistudio-llms`
- `C:\Users\sarunas\AppData\Local\Temp\musistudio-ccr`

---

A minimal, auditable Claude Code and Agent SDK router supporting Anthropic  ·  OpenRouter  ·  Gemini  ·  OpenAI  ·  Groq  ·  Mistral  ·  Ollama

| Based on  | musistudio/llms  +  musistudio/claude-code-router                                                        |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Strategy  | Inline the llms fork into src/core/; delete all extension machinery                                      |
| Providers | Anthropic  ·  OpenRouter  ·  Gemini  ·  OpenAI  ·  Groq  ·  Mistral  ·  Ollama — 7 hard-wired, no others |
| Goal      | Full auditability, pinned deps, no dynamic code loading, ~1,500 LOC                                      |
| Changelog | ...                                                                                                      |
| Date      | February 2026                                                                                            |



# 1. Goals & Non-Goals

1.1 Goals
---------

•       Intercept Claude Code's Anthropic API calls and routeto Anthropic, OpenRouter, Gemini, OpenAI, Groq, Mistral, or Ollama based on asimple config Router map.

•       Eliminate every dynamic code-execution pathway in theoriginal codebase (no require() of external files, no vm module, no pluginhooks, no agent injection).

•       Inline the @musistudio/llms dependency directly intosrc/core/ so all transformation code is local, version-controlled, andauditable in one repo.

•       Pin every dependency to an exact version. Commitpackage-lock.json. No caret, no tilde.

•       Reduce total runtime dependencies from 11 (llms) + manymore (CCR) to exactly 5.

•       Delete the UI package, preset system, plugin system,agent system, CDN fetching, and background daemon — everything not needed forthe three-provider routing task.

•       Keep a single flat package structure — no pnpmworkspaces, no monorepo, no build pipeline complexity.

•       Total auditable TypeScript: target ≤ 1,500 lines acrossall source files.
1.2 Non-Goals
-------------

•       Support for any provider other than Anthropic,OpenRouter, Gemini, OpenAI, Groq, Mistral, Ollama. No DeepSeek, Vertex,Bedrock, etc.

•       Web UI for configuration. Config is edited as a JSONfile.

•       Background daemon / service management. The server runsin the foreground.

•       Preset marketplace or downloadable provider registries.

•       Plugin / agent / custom-transformer extensibility. Thecodebase is intentionally closed.

•       Token counting for automatic long-context modelswitching.

•       Mid-conversation model switching via /model command.

•       Hot reload of config or transformers.

•       GitHub Actions non-interactive mode.



2. Source Inventory: Keep / Delete / Simplify
   =============================================

The following table maps everysignificant module in the original two repos to its fate in ccr-minimal.
2.1  @musistudio/llms  —  src/ decisions
----------------------------------------

| **Action**   | **Original path**                   | **Target path**                       | **Notes**                                                   |
| ------------ | ----------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| **INLINE**   | src/transformer/anthropic.ts        | src/core/transformers/anthropic.ts    | Keep as-is; remove dynamic options merging                  |
| **INLINE**   | src/transformer/gemini.ts           | src/core/transformers/gemini.ts       | Keep; handles Gemini tool quirks + URL routing              |
| **INLINE**   | src/transformer/openrouter.ts       | src/core/transformers/openrouter.ts   | Keep; handles cache_control header                          |
| **INLINE**   | src/utils/toolArgumentsParser.ts    | src/core/utils/toolArgumentsParser.ts | Patched (jsonrepair) version — verified no vm               |
| **INLINE**   | src/utils/sse.ts                    | src/core/utils/sse.ts                 | SSE streaming helpers, keep intact                          |
| **INLINE**   | src/api/middleware.ts               | src/core/api/middleware.ts            | Error handler, keep                                         |
| **NEW**      | —                                   | src/core/transformers/openai.ts       | New — near-passthrough, ~55 LOC                             |
| **NEW**      | —                                   | src/core/transformers/groq.ts         | New — OpenAI-compatible, base URL default only, ~30 LOC     |
| **NEW**      | —                                   | src/core/transformers/mistral.ts      | New — OpenAI-compatible + role:tool edge case, ~40 LOC      |
| **NEW**      | —                                   | src/core/transformers/ollama.ts       | New — OpenAI-compatible local endpoint, ~25 LOC             |
| **SIMPLIFY** | src/services/transformer.ts         | src/core/services/transformer.ts      | Static registry only — remove dynamic require() loader      |
| **SIMPLIFY** | src/services/config.ts              | src/core/services/config.ts           | Remove preset/CDN paths; keep env var interpolation         |
| **SIMPLIFY** | src/services/provider.ts            | src/core/services/provider.ts         | Remove token counting, model registry CDN                   |
| **SIMPLIFY** | src/api/routes.ts                   | src/core/api/routes.ts                | Keep /v1/messages + /health; remove all other endpoints     |
| **SIMPLIFY** | src/server.ts                       | src/core/server.ts                    | Remove plugin hooks, agent hooks, APIKEY middleware         |
| **SIMPLIFY** | src/types.ts                        | src/core/types.ts                     | Keep UnifiedChatRequest/Response; remove plugin/agent types |
| **DELETE**   | src/transformer/deepseek.ts         | —                                     | Not needed                                                  |
| **DELETE**   | src/transformer/vertex-*.ts         | —                                     | Not needed (2 files)                                        |
| **DELETE**   | src/transformer/groq.ts             | —                                     | Not needed                                                  |
| **DELETE**   | src/transformer/openai-responses.ts | —                                     | Not needed                                                  |
| **DELETE**   | src/transformer/reasoning.ts        | —                                     | No reasoning transformations needed                         |
| **DELETE**   | src/transformer/tooluse.ts          | —                                     | Only existed for DeepSeek workaround                        |
| **DELETE**   | src/transformer/maxtoken.ts         | —                                     | Config-driven cap not needed                                |
| **DELETE**   | src/transformer/enhancetool.ts      | —                                     | Buffers tool calls — not needed                             |
| **DELETE**   | src/transformer/cleancache.ts       | —                                     | Not needed                                                  |
| **DELETE**   | src/transformer/sampling.ts         | —                                     | Not needed                                                  |
| **DELETE**   | src/tokenizer/                      | —                                     | Entire directory — token counting not needed                |
| **DELETE**   | src/utils/geminiUtils.ts            | —                                     | Gemini-specific image/URL helpers only used by deleted code |

2.2  claude-code-router packages/  —  decisions
-----------------------------------------------

| **Action**   | **Original package**                             | **Rationale**                                                                              |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **DELETE**   | packages/ui/                                     | React web config UI — entire package dropped. Config is a JSON file.                       |
| **DELETE**   | packages/cli/ (most)                             | Preset commands, model selector UI, activate/deactivate env vars, daemon management        |
| **DELETE**   | packages/shared/                                 | Types inlined into src/core/types.ts                                                       |
| **DELETE**   | packages/server/src/plugins/                     | Plugin system entirely removed (CCRPlugin, pluginManager, outputHandler, tokenSpeedPlugin) |
| **DELETE**   | packages/server/src/agents/                      | Agent system entirely removed (agentsManager, imageAgent, IAgent, tool injection)          |
| **DELETE**   | packages/server/src/utils/router.ts (custom)     | Custom router script loading via require() — removed                                       |
| **DELETE**   | Preset system                                    | manifest.json, CDN fetching, install/activate commands entirely removed                    |
| **SIMPLIFY** | packages/server/ → src/                          | Flatten into a single package; server entry point becomes src/index.ts                     |
| **SIMPLIFY** | packages/cli/ → src/cli.ts                       | Keep only: start (foreground), version, help                                               |
| **KEEP**     | Routing logic                                    | model string parsing ('provider,model'), Router config map, provider lookup                |
| **KEEP**     | Config loading                                   | JSON5 file from ~/.config/ccr-minimal/config.json, env var interpolation                   |
| **KEEP**     | ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY env setup | The activation mechanism for Claude Code pointing to the proxy                             |



3. Target Directory Structure
   =============================

**Design principle**: Single flat package. Everything in one src/ tree. Noworkspaces. No build artifacts in the repo. No generated provider registry.

| **Path**                              | **Purpose**                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| src/core/transformers/anthropic.ts    | AnthropicTransformer — Anthropic ↔ OpenAI format conversion                     |
| src/core/transformers/gemini.ts       | GeminiTransformer — Gemini ↔ OpenAI, handles tool quirks, /v1beta URL           |
| src/core/transformers/openrouter.ts   | OpenRouterTransformer — strips cache_control on output, adds OR headers         |
| src/core/transformers/openai.ts       | OpenAITransformer — near-passthrough; adds response→Anthropic conversion        |
| src/core/transformers/groq.ts         | GroqTransformer — OpenAI-compatible, sets default base URL                      |
| src/core/transformers/mistral.ts      | MistralTransformer — OpenAI-compatible + role:tool edge case handling           |
| src/core/transformers/ollama.ts       | OllamaTransformer — OpenAI-compatible local endpoint, no auth required          |
| src/core/transformers/registry.ts     | Static import map: 7 providers — zero require()                                 |
| src/core/services/transformer.ts      | TransformerService — registers from registry.ts only, no initialize()           |
| src/core/services/config.ts           | ConfigService — loads JSON5, interpolates $ENV_VAR, validates provider names    |
| src/core/services/provider.ts         | ProviderService — resolves provider by name, validates against 3-name allowlist |
| src/core/api/routes.ts                | POST /v1/messages + GET /health — nothing else                                  |
| src/core/api/middleware.ts            | Error handler (unchanged from llms)                                             |
| src/core/utils/toolArgumentsParser.ts | jsonrepair-based parser — no vm, verified patched                               |
| src/core/utils/sse.ts                 | SSE streaming helpers (unchanged from llms)                                     |
| src/core/types.ts                     | UnifiedChatRequest, UnifiedChatResponse, ProviderConfig, RouterConfig           |
| src/core/server.ts                    | Fastify server class — no plugin system, no APIKEY middleware                   |
| src/router.ts                         | routeRequest() — splits 'provider,model', resolves transformer, forwards        |
| src/index.ts                          | Entry point — loads config, starts server on PORT (default 3456)                |
| src/cli.ts                            | start / version / help — 3 commands only                                        |
| config.example.json                   | Example config with all 3 providers and Router map                              |
| package.json                          | Exact pinned versions, no workspaces, no build scripts beyond tsc               |
| package-lock.json                     | Committed to git — reproducible installs                                        |
| tsconfig.json                         | strict: true, target: ES2022, module: CommonJS                                  |
| .nvmrc                                | Pinned Node version (18.20.x)                                                   |
| README.md                             | Setup, config, usage — includes security model section                          |

**Hard constraint**: No file outside src/core/transformers/registry.ts mayreference a transformer by string name or use require(). All transformer wiringis done through TypeScript static imports only.



4. Dependency Manifest — Exact Pinned Versions
   ==============================================

All versions pinned with norange operator. package-lock.json committed and enforced in CI.
4.1 Runtime dependencies  (5 total — down from 11+ in llms)
-----------------------------------------------------------

| **Package**   | **Version** | **Purpose / Why Kept**                                               |
| ------------- | ----------- | -------------------------------------------------------------------- |
| fastify       | 5.3.2       | HTTP server. Stays — it is the core server framework.                |
| @fastify/cors | 11.0.1      | CORS headers for local browser access if needed.                     |
| pino          | 9.6.0       | Structured logging. Already a fastify peer dep — zero extra weight.  |
| json5         | 2.2.3       | Config file parsing (allows comments in config.json).                |
| jsonrepair    | 3.12.0      | The security fix for toolArgumentsParser — replaces the vm fallback. |

**HTTP client**:Node 18+ native fetch (globalThis.fetch) replaces undici/node-fetch entirely.This removes one dependency and eliminates the need to audit an HTTP clientlibrary. Pin Node >= 18.20 in .nvmrc.
4.2 Dev dependencies  (3 total)
-------------------------------

| **Package** | **Version** | **Purpose**                                       |
| ----------- | ----------- | ------------------------------------------------- |
| typescript  | 5.8.3       | Compiler. strict: true. No ts-node in production. |
| tsx         | 4.19.3      | Dev-mode run (npx tsx src/index.ts). Not shipped. |
| @types/node | 22.14.0     | Node type definitions.                            |

**Removed dependencies**: tiktoken (token counting), undici (HTTP client), alltransformer-specific heavy utils, pnpm workspace tooling, vite/react (from UIpackage), and all CCR-specific utilities not in the above list.



5. Configuration Schema
   =======================

File location:~/.config/ccr-minimal/config.json  (JSON5— comments allowed)
5.1 Full example
----------------

{

  // LOG: emit request/response bodies tostdout. Keep false in production.

  "LOG": false,

  "API_TIMEOUT_MS": 300000,

  "PORT": 3456,

  "Providers": [

    {

      "name": "anthropic",

      "api_base_url":"https://api.anthropic.com",

      "api_key":"$ANTHROPIC_API_KEY"

    },

    {

      "name": "openrouter",

      "api_base_url":"https://openrouter.ai/api/v1/chat/completions",

      "api_key":"$OPENROUTER_API_KEY",

      "models":["google/gemini-2.5-pro-preview","anthropic/claude-sonnet-4"]

    },

    {

      "name": "gemini",

      "api_base_url":"https://generativelanguage.googleapis.com/v1beta/models/",

      "api_key":"$GEMINI_API_KEY",

      "models":["gemini-2.5-flash", "gemini-2.5-pro"]

    },

    {

      "name": "openai",

      "api_base_url":"https://api.openai.com/v1/chat/completions",

      "api_key":"$OPENAI_API_KEY",

      "models": ["gpt-4o","gpt-4.1"]

    },

    {

      "name": "groq",

      "api_base_url":"https://api.groq.com/openai/v1/chat/completions",

      "api_key":"$GROQ_API_KEY",

      "models":["llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"]

    },

    {

      "name": "mistral",

      "api_base_url":"https://api.mistral.ai/v1/chat/completions",

      "api_key":"$MISTRAL_API_KEY",

      "models":["codestral-latest", "mistral-large-latest"]

    },

    {

      "name": "ollama",

      "api_base_url":"http://localhost:11434/v1/chat/completions",

      "api_key":"ollama",          // Ollamaignores the key but field required

      "models":["qwen2.5-coder:latest"]

    }

  ],

  "Router": {

    "default":    "anthropic,claude-sonnet-4-20250514",

    "background":"groq,llama-3.3-70b-versatile"

  }

}
5.2 Schema rules
----------------

| **Field**        | **Rule**                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers[].name | Must be exactly one of: "anthropic", "openrouter", "gemini", "openai", "groq", "mistral", "ollama" — enforced at startup, hard error otherwise |
| api_key          | String or "$ENV_VAR" — interpolated at startup. Never stored in logs.                                                                          |
| Router.*         | Value must be "providerName,modelName" — split on first comma. providerName must match a configured Provider.                                  |
| Router keys      | "default" is required. "background" is optional — falls back to default if absent.                                                             |
| PORT             | Default 3456. Must match ANTHROPIC_BASE_URL env var.                                                                                           |
| PROXY_URL        | Optional. If set, all outbound requests use this proxy. (Original feature retained.)                                                           |

**No APIKEY**:The original CCR has an APIKEY field that gates access to the local proxy. Weremove it. Security model: the proxy binds to 127.0.0.1 only. Protect it withfilesystem permissions on the config file (chmod 600).



6. Transformer Specifications
   =============================

Each transformer implements theTransformer interface: transformRequestIn / transformRequestOut /transformResponseIn / transformResponseOut / endPoint. The unified internalformat is OpenAI chat completions.
6.1 AnthropicTransformer
------------------------

**Role**:Claude Code speaks Anthropic /v1/messages format natively. This transformerconverts that to OpenAI-unified on the way in, and converts OpenAI-unified backto Anthropic format on the way out. For routing back to the Anthropic APIdirectly, it acts as a near-pass-through.

| **Direction**        | **Transformation**                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| transformRequestIn   | Anthropic messages format → OpenAI messages format. Flattens system field into messages array. Normalises content blocks.     |
| transformRequestOut  | OpenAI format → Anthropic /v1/messages format. Reconstructs system string. Re-wraps content blocks. Preserves cache_control.  |
| transformResponseIn  | Anthropic streaming SSE (event: content_block_delta) → OpenAI streaming chunks (data: {...,choices:[{delta:{content:...}}]}). |
| transformResponseOut | OpenAI response → Anthropic Messages response. Reconstructs stop_reason, usage, content array.                                |
| endPoint             | "/v1/messages" — the Anthropic-native endpoint Claude Code calls.                                                             |

6.2 OpenRouterTransformer
-------------------------

**Role**:OpenRouter is OpenAI-compatible but has specific requirements: it needsHTTP-Referer and X-Title headers for attribution, and for Anthropic models viaOpenRouter, cache_control must be preserved rather than stripped (it passes itthrough to Anthropic).

| **Direction**        | **Transformation**                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transformRequestIn   | Largely pass-through (already unified/OpenAI). Accepts optional provider routing parameter for model-specific provider selection.                       |
| transformRequestOut  | Add HTTP-Referer: https://github.com/ccr-minimal header. Add X-Title: ccr-minimal header. Preserve cache_control (OpenRouter forwards it to Anthropic). |
| transformResponseIn  | Minimal — OpenRouter response is already OpenAI-compatible.                                                                                             |
| transformResponseOut | Reconstruct Anthropic response format from OpenAI format for Claude Code.                                                                               |
| endPoint             | No dedicated endpoint — uses provider api_base_url directly.                                                                                            |

6.3 GeminiTransformer
---------------------

**Role**:Gemini has the most non-trivial transformation: its URL uses a model-in-pathpattern, its tool parameter types have restrictions (string type cannot usemost format values), and it lacks tool call IDs. Streaming uses a different SSEstructure.

| **Direction**        | **Transformation**                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transformRequestIn   | Gemini generateContent format → OpenAI. Maps 'parts' to content, 'model' role to 'assistant', 'functionCall' to tool_calls, 'functionResponse' to tool results.                                                             |
| transformRequestOut  | OpenAI → Gemini generateContent format. Converts system message to systemInstruction. Converts tool definitions: removes 'format' from string params (only date/date-time allowed). Strips tool call IDs (Gemini has none). |
| transformResponseIn  | Gemini streaming (text/event-stream with 'data:' JSON blobs) → OpenAI SSE chunks.                                                                                                                                           |
| transformResponseOut | OpenAI response → Anthropic Messages format for Claude Code.                                                                                                                                                                |
| endPoint             | "/v1beta/models/:modelAndAction" — special Fastify route with param; model name embedded in URL path.                                                                                                                       |

**Gemini tool_call_id gap**: Gemini does not return tool call IDs. The transformer mustgenerate synthetic IDs on the response-in path and maintain a map for thesession to match function responses back to the correct tool use blocks. Thisis the most complex piece of logic in the entire fork — review carefully wheninlining.
6.4 OpenAITransformer
---------------------

**Role**:OpenAI uses the same format as the unified internal representation, making thisthe simplest transformer. The main work is reconstructing the Anthropic/v1/messages response format that Claude Code expects on the return path.

| **Direction**        | **Transformation**                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| transformRequestIn   | Near pass-through — unified format already is OpenAI format. Normalise content blocks if needed.       |
| transformRequestOut  | Pass-through — send OpenAI chat completions format directly.                                           |
| transformResponseIn  | Minimal — OpenAI SSE is the reference format; already in correct shape.                                |
| transformResponseOut | OpenAI response → Anthropic Messages format for Claude Code. Same logic as OpenRouter response-out.    |
| endPoint             | No dedicated endpoint. Uses provider api_base_url directly.                                            |
| Scope                | ~55 LOC. Note: o1/o3 reasoning models require developer role and no temperature — out of scope for v1. |

6.5 GroqTransformer
-------------------

**Role**:Groq's API is fully OpenAI-compatible. The transformer's only meaningfulfunction is providing a sensible default api_base_url and ensuring theresponse-out path reconstructs Anthropic format for Claude Code. Useful forrouting background/cheap tasks to fast Llama inference.

| **Direction**          | **Transformation**                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| transformRequestIn/Out | Pass-through — Groq accepts standard OpenAI chat completions format.                          |
| transformResponseIn    | Minimal — Groq returns standard OpenAI SSE.                                                   |
| transformResponseOut   | OpenAI response → Anthropic Messages format. Shared utility with OpenAI/Mistral transformers. |
| Scope                  | ~30 LOC. Realistic routing target: background model slot (fast, cheap Llama inference).       |

6.6 MistralTransformer
----------------------

**Role**:Mistral is OpenAI-compatible with one documented edge case: its tool resultmessages use role: 'tool' in a slightly different structure. For standard codeassistant use (no tool-heavy workflows) this difference is rarely triggered.Codestral is a strong coding model and a natural fit for the default orbackground slot.

| **Direction**        | **Transformation**                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transformRequestOut  | OpenAI format with one adjustment: ensure tool_result messages use Mistral's expected role/content structure if tool calls are present in the conversation. |
| transformResponseIn  | Standard OpenAI SSE — no changes needed.                                                                                                                    |
| transformResponseOut | OpenAI response → Anthropic Messages format. Shared utility.                                                                                                |
| Scope                | ~40 LOC. The role:tool edge case is a 5-line guard clause; rest is pass-through.                                                                            |

6.7 OllamaTransformer
---------------------

**Role**:Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint locally. ZeroAPI key required (field accepted but ignored). Intended use: routing backgroundtasks fully offline — zero cost, zero data egress for dev/test workloads.api_base_url defaults to localhost:11434.

| **Direction**        | **Transformation**                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| All directions       | Full pass-through — Ollama's OpenAI-compatible endpoint needs no transformation.                                   |
| transformResponseOut | OpenAI response → Anthropic Messages format. Shared utility.                                                       |
| Scope                | ~25 LOC. Essentially just registering a name and default base URL.                                                 |
| Special note         | api_key field in config must be present but value is ignored. Recommend literal string "ollama" as a clear signal. |

**Shared utility**: OpenAI, Groq, Mistral, and Ollama all share the sametransformResponseOut logic (OpenAI format → Anthropic Messages). Extract thisinto src/core/utils/openaiToAnthropic.ts (~40 LOC) and import it in all fourtransformers. This keeps the four transformer files minimal and ensures theconversion is tested once.
6.8 Static registry — the key securityimprovement
-------------------------------------------------

The originalTransformerService.initialize() used a dynamic import mechanism to loadtransformers specified by file path from config. This is replaced with a staticTypeScript import map:

//src/core/transformers/registry.ts

import{ AnthropicTransformer }  from'./anthropic';

import{ OpenRouterTransformer } from './openrouter';

import{ GeminiTransformer }     from'./gemini';

import{ OpenAITransformer }     from'./openai';

import{ GroqTransformer }       from './groq';

import{ MistralTransformer }    from'./mistral';

import{ OllamaTransformer }     from'./ollama';

exportconst TRANSFORMERS = {

  anthropic:   new AnthropicTransformer(),

  openrouter:  new OpenRouterTransformer(),

  gemini:      new GeminiTransformer(),

  openai:      new OpenAITransformer(),

  groq:        new GroqTransformer(),

  mistral:     new MistralTransformer(),

  ollama:      new OllamaTransformer(),

}as const;

exporttype SupportedProvider = keyof typeof TRANSFORMERS;

**No dynamic loading allowed**: The TransformerService must only callTRANSFORMERS[name] where name has been validated againstObject.keys(TRANSFORMERS). It must never accept a file path, call require(),call import(), or execute any user-supplied string as code. Any PR thatviolates this must be rejected.



7. Service Simplifications
   ==========================

7.1 TransformerService  (src/core/services/transformer.ts)
----------------------------------------------------------

Original: asynchronousinitialize() that dynamically loads external transformer files via require();maintains a registry that can be extended at runtime.

New: synchronous constructoronly. Imports TRANSFORMERS from registry.ts. Exposes get(name:SupportedProvider) and getAll(). No initialize(). No async startup. No dynamicregistration.

classTransformerService {

  private registry = TRANSFORMERS;

  get(name: SupportedProvider) { returnthis.registry[name]; }

  getAll() { returnObject.values(this.registry); }

}

Consequence for server.ts: nomore .finally() async chain in the constructor. All services can beinstantiated synchronously. Server startup is simpler and faster.
7.2 ConfigService  (src/core/services/config.ts)
------------------------------------------------

Original: loads from multiplelocations (HOME_DIR, project dir, env), supports APIKEY, NON_INTERACTIVE_MODE,hot reload, preset activation state.

New: loads exactly one file:~/.config/ccr-minimal/config.json. Interpolates $ENV_VAR references in api_keyfields. Validates that all provider names are in the allowed set. ValidatesRouter values are 'name,model' strings pointing to configured providers. Failshard on invalid config — no silent defaults.
7.3 ProviderService  (src/core/services/provider.ts)
----------------------------------------------------

Original: loads a remoteprovider registry from CDN, supports token counting for context-length routing,dynamic model switching.

New: resolves provider by namefrom config only. No network calls. No token counting. No model list CDNfetching. Validates provider name is in { anthropic, openrouter, gemini } atresolution time.
7.4 Server  (src/core/server.ts)
--------------------------------

Original: registers plugin hooks(preHandler for plugin system), agent hooks (preHandler for tool injection +onSend for stream rewriting), CORS, APIKEY middleware.

New: registers only the errorhandler and CORS. No plugin hooks. No agent hooks. No APIKEY check. TwopreHandler hooks remain (request logging + model/provider extraction — same asoriginal). Binds to 127.0.0.1 only — not 0.0.0.0.
7.5 API routes  (src/core/api/routes.ts)
----------------------------------------

Original: registers health,provider management, LLM interaction, transformer-specific, preset, plugin,log, and config API endpoints.

New: two routes only.

•       POST /v1/messages — the main routing endpoint. Readsprovider from req.provider (set by preHandler), calls transformer chain,forwards to provider, streams response back.

•       GET /health — returns { status: 'ok', version,providers: ['anthropic','openrouter','gemini'] }.



8. CLI  (src/cli.ts)
   ====================

Three commands only. No daemonmanagement. No preset commands. No model selector. No UI command.

| **Command**         | **Behaviour**                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ccr-minimal start   | Load config, start Fastify server in foreground on PORT (default 3456). Print activation instructions. Ctrl-C to stop. |
| ccr-minimal version | Print package version and Node version.                                                                                |
| ccr-minimal help    | Print usage with config file location and example ANTHROPIC_BASE_URL export.                                           |

On start, print the two env varsthe user needs to set for Claude Code:

exportANTHROPIC_BASE_URL=http://127.0.0.1:3456

exportANTHROPIC_API_KEY=any-non-empty-string

**No background daemon**: Users run ccr-minimal start in a terminal and leave itrunning. No PID files, no systemd integration, no launchd plist. This keeps theattack surface minimal — no auto-start on login, no persistent process withoutexplicit user action.



9. Security Improvements vs. Original
   =====================================

| **Risk**                               | **Original CCR**                       | **ccr-minimal**                                                                   |
| -------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| vm.runInContext injection              | Present (patched in v1.0.16)           | Absent — uses jsonrepair only                                                     |
| Dynamic require() transformers         | Yes — user-specified file paths        | No — static import registry                                                       |
| Plugin hooks (arbitrary code)          | Yes — CCRPlugin.register()             | No — plugin system deleted                                                        |
| Agent tool injection                   | Yes — IAgent.shouldHandle()            | No — agent system deleted                                                         |
| CDN-fetched provider registry          | Yes — Cloudflare R2 on startup         | No — config file only                                                             |
| Preset installation (config injection) | Yes — from GitHub                      | No — preset system deleted                                                        |
| Custom router scripts                  | Yes — require() at startup             | No — deleted                                                                      |
| External @musistudio/* npm dep         | Yes — separate package                 | No — inlined in src/core/                                                         |
| Opaque npm bundle                      | Compiled CJS, source gap               | Source is the runnable code (tsx)                                                 |
| Unlocked dependencies                  | ^ ranges, auto-update                  | Exact versions, locked                                                            |
| 11+ runtime dependencies               | 11 in llms + CCR extras                | 5 runtime deps total (7 providers — all OpenAI-compat new ones share same 5 deps) |
| Binds to 0.0.0.0                       | Yes — configurable, default may differ | No — 127.0.0.1 hardcoded                                                          |
| Telemetry                              | None detected (not confirmed)          | None — no external calls except providers                                         |

**Auditability**:With ~900 LOC and no compiled bundle, a developer can read the entire codebasein under 2 hours and have complete confidence in what runs. The original CCR +llms combination exceeds 4,000 LOC across 5 packages before the UI.



10. Implementation Phases
    =========================

| **#** | **Phase**           | **Work**                                                                                                                                                                                       | **Est.**              |
| ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | Repo setup          | Create ccr-minimal repo. Copy llms src/ into src/core/. Copy CCR packages/server/src/ routing logic into src/. Add .nvmrc, tsconfig.json, empty package.json.                                  | 0.5 day               |
| 1     | Delete dead code    | Remove 11 transformer files, tokenizer dir, plugin system, agent system, preset system, UI package, custom router script support from both code trees.                                         | 1 day                 |
| 2     | Static registry     | Create src/core/transformers/registry.ts with all 7 static imports. Rewrite TransformerService to use it synchronously. Update server.ts constructor (remove async chain).                     | 0.5 day               |
| 3     | Services            | Simplify ConfigService (single file path, 7-name validation). Simplify ProviderService (no CDN, no token counting). Simplify server.ts (remove plugin/agent hooks, APIKEY, bind to 127.0.0.1). | 1 day                 |
| 4     | Routes & CLI        | Slim api/routes.ts to 2 routes. Write src/cli.ts (3 commands). Write src/index.ts entry point.                                                                                                 | 1 day                 |
| 5a    | New transformers    | Write openai.ts, groq.ts, mistral.ts, ollama.ts. Extract shared openaiToAnthropic.ts utility. Wire into registry.                                                                              | 0.5 day               |
| 5b    | Verify transformers | End-to-end tests against all 7 providers. Verify Gemini tool call ID synthesis. OpenRouter cache_control. OpenAI/Groq/Mistral/Ollama response reconstruction. Anthropic streaming.             | 2 days                |
| 6     | Deps & lock         | Pin all 5 runtime + 3 dev deps to exact versions. Run npm install. Commit package-lock.json. Verify npm audit clean.                                                                           | 0.5 day               |
| 7     | Docs & review       | Write README. Write SECURITY.md. Final code review: grep for vm, require, eval, process.binding. Count LOC.                                                                                    | 0.5 day               |
| —     | Total               |                                                                                                                                                                                                | ~7.5–8 developer days |

10.1 Phase 1 deletion checklist
-------------------------------

These files must not exist inthe final repo. Verify with git ls-files after deletion:

•       src/core/transformers/deepseek.ts

•       src/core/transformers/vertex-gemini.ts

•       src/core/transformers/vertex-claude.ts

•       src/core/transformers/groq.ts

•       src/core/transformers/openai-responses.ts

•       src/core/transformers/reasoning.ts

•       src/core/transformers/tooluse.ts

•       src/core/transformers/maxtoken.ts

•       src/core/transformers/enhancetool.ts

•       src/core/transformers/cleancache.ts

•       src/core/transformers/sampling.ts

•       src/core/tokenizer/ (entire directory)

•       src/core/utils/geminiUtils.ts

•       Any file containing 'plugin', 'agent', 'preset','router.js', 'custom-router'
10.2 Phase 6 security verification script
-----------------------------------------

Run before any commit to main:

#Must return zero results:

grep-rn 'vm\.runInContext\|vm\.createContext\|require(.*path\|new Function(' src/

#Must return exactly one result (registry.ts):

grep-rn 'import.*Transformer' src/core/ | grep -v 'registry.ts'

#→ should be empty (all transformer imports only from registry.ts)

#Must return zero results:

grep-rn 'plugin\|agent\|preset\|cdnUrl\|providerRegistry' src/



11. Open Questions Before Starting
    ==================================

| **#** | **Question**                                                                                                                                                                                                                                                                              | **Decision needed**                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | Gemini streaming: the original llms Gemini transformer handles /v1beta/models/:modelAndAction as a special Fastify route with a URL parameter. Should we keep this special endpoint or normalise Gemini to the same /v1/messages route and rewrite the URL internally in the transformer? | Recommend keep the special endpoint — less risk of breaking Gemini streaming                            |
| 2     | Anthropic transformer: when routing to the Anthropic API directly, the transformer is essentially a no-op (Claude Code sends Anthropic format, Anthropic expects Anthropic format). Should it still convert through OpenAI unified format as an intermediate, or short-circuit?           | Recommend keep unified-format round-trip for consistency — short-circuit adds special-case complexity   |
| 3     | PROXY_URL: the original supports routing all outbound requests through an HTTP proxy. Keep or drop?                                                                                                                                                                                       | Recommend KEEP — useful for enterprise environments. Implementation is a single fetch option.           |
| 4     | Router keys: the original CCR has 4 routing scenarios (default, background, think, longContext). We are keeping default and background. Think routes reasoning models — no reasoning-specific transformers are in scope. Is that acceptable?                                              | Recommend accept this constraint for v1. o1/o3 and DeepSeek-R1 support can be scoped to a v2 if needed. |
| 5     | Package name and distribution: should the repo be published as a private GitHub package, installed globally via npm install -g, or run in-place via npx tsx?                                                                                                                              | Recommend local install only: git clone + npm install -g . No npm registry publication.                 |



12. Estimated Lines of Code
    ===========================

| **File**                              | **Est. LOC** | **Notes**                                                           |
| ------------------------------------- | ------------ | ------------------------------------------------------------------- |
| src/core/transformers/anthropic.ts    | ~180         | Converted from llms — remove generics/options                       |
| src/core/transformers/gemini.ts       | ~220         | Most complex — tool quirks, URL routing, ID synthesis               |
| src/core/transformers/openrouter.ts   | ~60          | Headers + cache_control pass-through                                |
| src/core/transformers/openai.ts       | ~55          | Near-passthrough + response reconstruction                          |
| src/core/transformers/groq.ts         | ~30          | Name + default URL + response reconstruction                        |
| src/core/transformers/mistral.ts      | ~40          | role:tool edge case guard + pass-through                            |
| src/core/transformers/ollama.ts       | ~25          | Local endpoint name + pass-through                                  |
| src/core/transformers/registry.ts     | ~20          | 7-entry static import map                                           |
| src/core/utils/openaiToAnthropic.ts   | ~40          | Shared response reconstruction utility (OpenAI/Groq/Mistral/Ollama) |
| src/core/services/transformer.ts      | ~30          | Synchronous wrapper around registry                                 |
| src/core/services/config.ts           | ~80          | File load, env interpolation, 7-name validation                     |
| src/core/services/provider.ts         | ~50          | Name lookup + validation                                            |
| src/core/api/routes.ts                | ~70          | Two routes only                                                     |
| src/core/api/middleware.ts            | ~30          | Error handler                                                       |
| src/core/utils/toolArgumentsParser.ts | ~40          | jsonrepair version                                                  |
| src/core/utils/sse.ts                 | ~60          | SSE helpers                                                         |
| src/core/types.ts                     | ~60          | Type definitions                                                    |
| src/core/server.ts                    | ~100         | Fastify setup, simplified                                           |
| src/router.ts                         | ~50          | Route request to provider                                           |
| src/index.ts                          | ~30          | Boot sequence                                                       |
| src/cli.ts                            | ~60          | 3 commands                                                          |
| TOTAL                                 | ~1380        | vs. 4,000+ in original (excl. UI). 7 providers, 5 deps.             |
