// Shared utility: OpenAI ↔ Anthropic response conversion.
//
// The actual conversion logic lives in AnthropicTransformer.transformResponseIn
// (streaming) and AnthropicTransformer.convertOpenAIResponseToAnthropic (JSON).
//
// OpenAI-compatible providers (OpenAI, Groq, Mistral, Ollama) don't need a
// transformResponseOut step — their responses are already in OpenAI format.
// The Anthropic transformer handles the final conversion to Anthropic format.
//
// This file is kept as documentation of the architecture decision.
// No runtime code is needed here.
