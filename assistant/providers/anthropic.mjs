// Anthropic Messages API client implementation
// This file was generated with the assistance of an AI coding tool.

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates an Anthropic Messages API client
 * @param {Object} config - Configuration object
 * @param {string} config.apiKey - Anthropic API key
 * @param {string} [config.baseUrl='https://api.anthropic.com'] - Base URL for the API
 * @returns {Object} - Client with createMessage method
 */
export function createClient({ apiKey, baseUrl = 'https://api.anthropic.com' }) {
  return {
    /**
     * Creates a message using Anthropic Messages API
     * @param {Object} options - Message options
     * @param {AbortSignal} [options.signal] - Abort signal
     * @param {number} [options.timeoutMs=120000] - Request timeout
     * @param {Object} options.body - Request body
     * @returns {Promise<Object>} - Message response
     */
    async createMessage({ signal, timeoutMs = 120_000, body }) {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
        });

        if (response.ok) {
          const data = await response.json();
          // Transform Anthropic response to common format
          return transformResponse(data);
        }

        if (RETRYABLE.has(response.status) && attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }

        let detail = response.statusText;
        try {
          detail = (await response.json())?.error?.message ?? detail;
        } catch {
          /* not JSON */
        }
        throw new Error(`Anthropic API error (${response.status}): ${detail}`);
      }
    },
  };
}

/**
 * Transforms Anthropic API response to common format
 * @param {Object} anthropicResponse - Raw Anthropic response
 * @returns {Object} - Transformed response
 */
function transformResponse(anthropicResponse) {
  // Map Anthropic's content blocks to our format
  const content = anthropicResponse.content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };
      default:
        return block;
    }
  });

  return {
    id: anthropicResponse.id,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: anthropicResponse.stop_reason,
    stop_sequence: anthropicResponse.stop_sequence,
    usage: anthropicResponse.usage,
  };
}

// Legacy export for backward compatibility
export async function createMessage({ apiKey, baseUrl, body, signal, timeoutMs }) {
  const client = createClient({ apiKey, baseUrl });
  return client.createMessage({ signal, timeoutMs, body });
}
