# Gemini 3.8 through the Claude Agent SDK

This patch was tested with Agent SDK 0.3.195 / Claude Code 2.1.195 and
OpenRouter `google/gemini-3.8-flash`. It does not require application changes.

The HTTP pipeline now creates transformers per request. A response therefore
uses the tool-name map belonging to its own request even when other requests
or SDK helpers are in flight. Both standard and gateway routes use this path.

For the Gemini 3.8 model family, an explicit disabled/zero reasoning request is
translated to enabled reasoning with low effort. This accommodates SDK helper
requests because that endpoint rejects disabled reasoning. Gemini 2.5 and
unrelated models keep their requested reasoning controls.

OpenRouter reasoning fields, including encrypted data, IDs, order, and format,
are carried in a versioned `redacted_thinking.data` envelope. The request adapter
restores them only for the same routed model. This is a transport envelope, not
a fabricated Anthropic signature, and needs no server-side session cache.
Provider tool-call IDs are preserved because encrypted metadata can refer to
them. Responses echo the client's requested model alias: the SDK otherwise
strips thinking associated with a different response model. Provider captures
still record the actual backend model; client model names are routing aliases,
not proof of which provider executed a request.

Gemini SSE responses are buffered per upstream response, up to 16 MiB, so late
reasoning metadata can precede the answer/tool blocks. The SDK discards trailing
thinking and can return an empty final result when the last block is thinking.
The downstream protocol remains SSE, but first visible output waits for the
upstream response to complete. This is a latency tradeoff, not token-by-token
streaming from Gemini. Other OpenRouter models are not buffered by this change.

`npm run test:unit` runs the existing usage/stream tests and the new regression
suite. The latter covers overlapping HTTP requests, JSON and fragmented SSE,
late opaque metadata, numeric tool IDs, model identity, final-answer ordering,
and serialization across fresh transformer instances. Live SDK/Chassis results
are recorded separately in the integration-test artifact supplied with this
patch. Direct Google API reasoning transport is outside this patch's verified
scope. Existing sessions that already lost their metadata cannot be repaired
retroactively; start a fresh session for acceptance testing.
