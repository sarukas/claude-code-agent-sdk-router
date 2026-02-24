# Known Compatibility Issues

## Image Format Conversion

### Status: Handled

Claude Code sends images in Anthropic's native content block format. Non-Anthropic providers (OpenRouter, Gemini, OpenAI, Groq, Mistral, Ollama) expect the OpenAI-compatible `image_url` format. The proxy converts between these automatically.

### Format Differences

| Field | Claude Native | OpenAI-Compatible (Unified) |
|-------|--------------|----------------------------|
| Block type | `"type": "image"` | `"type": "image_url"` |
| Data location | `source.data` (raw base64) | `image_url.url` (data URI with prefix) |
| Media type | `source.media_type` (separate field) | Embedded in data URI: `data:{media_type};base64,{data}` |
| Source type | `source.type`: `"base64"` or `"url"` | Inferred from URL prefix |

### Claude Native (what Claude Code sends)

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

URL variant:
```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/photo.jpg"
  }
}
```

### OpenAI-Compatible (what providers receive)

```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,iVBORw0KGgo..."
  }
}
```

URL variant:
```json
{
  "type": "image_url",
  "image_url": {
    "url": "https://example.com/photo.jpg"
  }
}
```

### Where Conversion Happens

- **Anthropic `transformRequestOut`** (`src/core/transformers/anthropic.ts:78-98`): Converts `{type: "image", source: {...}}` blocks to `{type: "image_url", image_url: {url: "data:..."}}` as part of Anthropic-to-unified conversion. Handles both `base64` and `url` source types.
- **`formatBase64`** (`src/core/utils/image.ts`): Utility that constructs the `data:{media_type};base64,{data}` URI, with guard against double-encoding.
- **OpenRouter `transformRequestIn`** (`src/core/transformers/openrouter.ts:25-28`): Additional handling for Claude-via-OpenRouter — wraps raw base64 into data URIs for Claude models.
- **Gemini `transformRequestIn`** (`src/core/transformers/gemini.ts:153-158`): Converts `image_url` to Gemini's native `inlineData`/`file_data` format.

### Supported Media Types

All APIs support: `image/jpeg`, `image/png`, `image/gif`, `image/webp`

### Known Limitation: Images Inside Tool Results

When Claude Code sends a `tool_result` containing image data, the content is serialized via `JSON.stringify` rather than having its image blocks converted to `image_url` format (`src/core/transformers/anthropic.ts:71`). This means images embedded within tool results will be passed as stringified JSON rather than proper image blocks.

**Practical impact**: Low. Claude Code sends tool results with images as content arrays in user-role messages (which are converted correctly), not inside `tool_result` blocks. This would only affect custom Agent SDK tools that return raw image content blocks in their tool results.

**Workaround**: If a custom tool needs to return images in tool results, encode them as base64 strings in the text content and have the model interpret them, or restructure the tool to return image data in a separate user message.
