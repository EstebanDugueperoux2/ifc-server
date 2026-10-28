# Multi-Provider AI Assistant Changes

This document describes the changes made to support multiple AI providers in the IfcOpenShell assistant.

## Overview

The assistant has been refactored to support multiple AI providers (Anthropic, OpenAI, Mistral, Google) instead of being hardcoded to only work with Anthropic. The implementation uses a provider abstraction pattern that allows:

- Easy switching between providers via environment variables
- Consistent API across all providers
- Backward compatibility with existing Anthropic deployments

## Directory Structure

```
assistant/
├── server.mjs              # Updated: Main HTTP server with multi-provider support
├── agent.mjs               # Updated: Uses provider abstraction
├── conversation.mjs        # Unchanged: Conversation state management
├── create-model.mjs        # Unchanged: Model creation logic
├── mcp-session.mjs         # Unchanged: MCP session management
├── tools.mjs               # Unchanged: Tool definitions
├── Dockerfile              # Updated: Includes providers directory
├── package.json            # Unchanged: Dependencies
└── providers/              # NEW: Provider implementations
    ├── index.mjs           # Exports all provider modules
    ├── provider.mjs        # Provider abstraction and factory
    ├── anthropic.mjs       # Anthropic Messages API implementation
    ├── openai.mjs          # OpenAI Chat Completions implementation
    ├── mistral.mjs         # Mistral AI API implementation
    ├── google.mjs          # Google Gemini API implementation
    └── README.md           # Documentation for providers
```

## Changes by File

### 1. `providers/provider.mjs` (NEW)

- Defines the provider abstraction interface
- Exports `ProviderTypes` enum for supported providers
- Implements `createProviderClient()` factory function
- Exports `validateProviderConfig()` for configuration validation

### 2. `providers/anthropic.mjs` (NEW)

- Implements Anthropic Messages API client
- Exports `createClient()` function
- Transforms responses to common format
- Maintains backward compatibility with old `createMessage` export

### 3. `providers/openai.mjs` (NEW)

- Implements OpenAI Chat Completions API client
- Handles request/response transformation between Anthropic and OpenAI formats
- Supports tool/function calling

### 4. `providers/mistral.mjs` (NEW)

- Implements Mistral AI API client
- Handles Mistral-specific request/response formats
- Supports tool/function calling

### 5. `providers/google.mjs` (NEW)

- Implements Google Gemini API client
- Handles Google-specific request/response formats
- Limited tool support (Google's API has different capabilities)

### 6. `providers/index.mjs` (NEW)

- Central export point for all provider modules

### 7. `server.mjs` (MODIFIED)

**Configuration Changes:**
- Added `provider` configuration option (default: 'anthropic')
- Added provider-specific base URLs for each provider
- Updated model configuration to support per-provider defaults
- Added `createProvider()` function to instantiate the correct provider client

**Runtime Changes:**
- Creates provider client at startup
- Passes provider to conversations
- Health endpoint now shows provider information
- Startup message includes provider type

**New Environment Variables:**
- `ASSISTANT_PROVIDER`: Provider type ('anthropic', 'openai', 'mistral', 'google')
- `OPENAI_API_KEY`: API key for OpenAI
- `OPENAI_BASE_URL`: Base URL for OpenAI API
- `OPENAI_MODEL`: Default model for OpenAI
- `MISTRAL_API_KEY`: API key for Mistral
- `MISTRAL_BASE_URL`: Base URL for Mistral API
- `MISTRAL_MODEL`: Default model for Mistral
- `GOOGLE_API_KEY`: API key for Google
- `GOOGLE_BASE_URL`: Base URL for Google API
- `GOOGLE_MODEL`: Default model for Google

### 8. `agent.mjs` (MODIFIED)

- Updated imports to use provider from conversation
- Uses provider client's `createMessage()` method instead of direct import
- Receives providerConfig from conversation

### 9. `Dockerfile` (MODIFIED)

- Added `COPY providers/ ./providers/` to include provider implementations

### 10. `test/e2e.test.mjs` (MODIFIED)

- Added `ASSISTANT_PROVIDER: 'anthropic'` to test configurations

### 11. Old `anthropic.mjs` (REMOVED)

- Deleted from root directory
- Functionality moved to `providers/anthropic.mjs`

## Configuration Examples

### Anthropic (default)
```bash
ASSISTANT_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk_...
ANTHROPIC_MODEL=claude-sonnet-5-5
```

### OpenAI
```bash
ASSISTANT_PROVIDER=openai
OPENAI_API_KEY=sk_...
OPENAI_MODEL=gpt-4
```

### Mistral
```bash
ASSISTANT_PROVIDER=mistral
MISTRAL_API_KEY=sk_...
MISTRAL_MODEL=mistral-large
```

### Google (Gemini)
```bash
ASSISTANT_PROVIDER=google
GOOGLE_API_KEY=AIza...
GOOGLE_MODEL=gemini-pro
```

## Response Format Standardization

All providers transform their responses to a common format:

```javascript
{
  id: string,              // Response ID
  type: 'message',         // Message type
  role: 'assistant',       // Message role
  content: [              // Array of content blocks
    { type: 'text', text: string } |        // Text content
    { type: 'tool_use', id: string, name: string, input: object }  // Tool call
  ],
  stop_reason: string,     // 'end_turn' | 'tool_use' | 'max_tokens'
  usage: {                 // Token usage
    input_tokens: number,
    output_tokens: number
  }
}
```

## Backward Compatibility

The implementation maintains full backward compatibility:

- Default provider is 'anthropic'
- Existing `ANTHROPIC_API_KEY` and related variables still work
- Configuration falls back to Anthropic settings when provider is not specified
- Old tests continue to work with minor adjustments

## Adding New Providers

To add a new AI provider:

1. Create a new file in `providers/` (e.g., `new-provider.mjs`)
2. Implement the `createClient()` function that returns:
   ```javascript
   {
     createMessage: async ({ signal, timeoutMs, body }) => {
       // Transform request and call provider API
       // Return response in common format
     }
   }
   ```
3. Add the provider type to `ProviderTypes` in `providers/provider.mjs`
4. Add the provider to the switch statement in `createProviderClient()` in `providers/provider.mjs`
5. Update the configuration in `server.mjs` to support the new provider's environment variables

## Testing

The existing test suite has been updated to work with the new provider system. Tests explicitly set `ASSISTANT_PROVIDER: 'anthropic'` to ensure they use the Anthropic provider for testing with the mock server.

## Notes

- Each provider implementation handles the transformation between the common request/response format and the provider's native API format
- Tool/function calling is supported where available, with appropriate transformations
- Error handling and retries are implemented per-provider
- The abstraction allows for provider-specific features while maintaining a consistent interface for the agent
