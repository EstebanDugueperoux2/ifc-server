# AI Providers

This directory contains implementations for various AI providers that the assistant can use.

## Supported Providers

- **Anthropic** (`anthropic`) - Claude models via Messages API
- **OpenAI** (`openai`) - Chat Completions API
- **Mistral** (`mistral`) - Mistral AI API
- **Google** (`google`) - Google Gemini API

## Configuration

Set the `ASSISTANT_PROVIDER` environment variable to specify which provider to use:

```bash
ASSISTANT_PROVIDER=anthropic  # Default
ASSISTANT_PROVIDER=openai
ASSISTANT_PROVIDER=mistral
ASSISTANT_PROVIDER=google
```

### Provider-Specific Configuration

Each provider requires its own API key:

- **Anthropic**: `ANTHROPIC_API_KEY` (default), `ANTHROPIC_BASE_URL`
- **OpenAI**: `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- **Mistral**: `MISTRAL_API_KEY`, `MISTRAL_BASE_URL`
- **Google**: `GOOGLE_API_KEY`, `GOOGLE_BASE_URL`

The assistant will use the appropriate API key based on the selected provider.

### Common Configuration

All providers share these configuration options:

- `MODEL` - The model identifier (e.g., `claude-sonnet-5-5`, `gpt-4`, `mistral-large`)
- `MAX_TOKENS` - Maximum tokens to generate per response
- `REQUEST_TIMEOUT_SEC` - Request timeout in seconds

## Adding a New Provider

To add a new AI provider:

1. Create a new file in this directory (e.g., `new-provider.mjs`)
2. Implement the `createClient` function that returns a client object with a `createMessage` method
3. Export the `createClient` function
4. Add the provider type to `ProviderTypes` in `provider.mjs`
5. Add the provider to the switch statement in `createProviderClient` in `provider.mjs`

The `createMessage` method should:

- Accept options: `{ signal, timeoutMs, body }`
- Transform the Anthropic-style request to the provider's format
- Return a response in the common format:
  ```javascript
  {
    id: string,
    type: 'message',
    role: 'assistant',
    content: Array<{ type: 'text' | 'tool_use', ... }>,
    stop_reason: string,
    usage: { input_tokens: number, output_tokens: number }
  }
  ```

## Response Format

All providers transform their responses to a common format:

- `content` - Array of content blocks:
  - `{ type: 'text', text: string }` - Text content
  - `{ type: 'tool_use', id: string, name: string, input: object }` - Tool/function call
- `stop_reason` - Why generation stopped:
  - `'end_turn'` - Model finished normally
  - `'tool_use'` - Model wants to call a tool
  - `'max_tokens'` - Hit token limit
- `usage` - Token usage statistics
