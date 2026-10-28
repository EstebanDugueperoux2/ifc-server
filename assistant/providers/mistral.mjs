// Mistral AI API client implementation
// This file was generated with the assistance of an AI coding tool.

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a Mistral AI API client
 * @param {Object} config - Configuration object
 * @param {string} config.apiKey - Mistral API key
 * @param {string} [config.baseUrl='https://api.mistral.ai/v1'] - Base URL for the API
 * @returns {Object} - Client with createMessage method
 */
export function createClient({ apiKey, baseUrl = 'https://api.mistral.ai/v1' }) {
  return {
    /**
     * Creates a message using Mistral Chat Completions API
     * @param {Object} options - Message options
     * @param {AbortSignal} [options.signal] - Abort signal
     * @param {number} [options.timeoutMs=120000] - Request timeout
     * @param {Object} options.body - Request body (Anthropic format, will be transformed)
     * @returns {Promise<Object>} - Message response in common format
     */
    async createMessage({ signal, timeoutMs = 120_000, body }) {
      // Transform Anthropic-style request to Mistral format
      const mistralBody = transformRequest(body);

      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(mistralBody),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
        });

        if (response.ok) {
          const data = await response.json();
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
        throw new Error(`Mistral API error (${response.status}): ${detail}`);
      }
    },
  };
}

/**
 * Transforms Anthropic-style request to Mistral Chat Completions format
 * @param {Object} anthropicBody - Request in Anthropic format
 * @returns {Object} - Request in Mistral format
 */
function transformRequest(anthropicBody) {
  const { model, max_tokens, system, tools, messages } = anthropicBody;

  // Map tools to Mistral tool format
  const mistralTools = tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: transformSchema(tool.input_schema),
    },
  })) || [];

  // Map messages to Mistral format
  const mistralMessages = [];

  // Add system prompt
  if (system && system.length > 0) {
    const systemText = system
      .filter((s) => s.type === 'text')
      .map((s) => s.text)
      .join('\n');
    if (systemText) {
      mistralMessages.push({ role: 'system', content: systemText });
    }
  }

  // Add conversation messages
  for (const msg of messages || []) {
    const role = msg.role;
    const content = msg.content;

    // Handle different content types
    if (Array.isArray(content)) {
      const textParts = [];
      const toolCalls = [];
      const toolResults = [];

      for (const block of content) {
        switch (block.type) {
          case 'text':
            textParts.push(block.text);
            break;
          case 'tool_use':
            toolCalls.push({
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            });
            break;
          case 'tool_result':
            toolResults.push({
              type: 'function',
              function: {
                name: block.name || 'unknown',
              },
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {}),
              tool_call_id: block.tool_use_id,
            });
            break;
        }
      }

      const mistralMsg = { role };
      if (textParts.length > 0) {
        mistralMsg.content = textParts.join('');
      }
      if (toolCalls.length > 0 && role === 'assistant') {
        mistralMsg.tool_calls = toolCalls;
      }
      if (toolResults.length > 0 && role === 'user') {
        mistralMsg.tool_calls = toolResults;
      }
      mistralMessages.push(mistralMsg);
    } else if (typeof content === 'string') {
      mistralMessages.push({ role, content });
    }
  }

  return {
    model,
    max_tokens,
    tools: mistralTools.length > 0 ? mistralTools : undefined,
    messages: mistralMessages,
    ...(mistralTools.length > 0 ? { tool_choice: 'auto' } : {}),
  };
}

/**
 * Transforms JSON schema to Mistral function parameters format
 * @param {Object} schema - Input schema
 * @returns {Object} - Mistral parameters object
 */
function transformSchema(schema) {
  if (!schema) return { type: 'object', properties: {} };

  const { properties, required, ...rest } = schema;

  return {
    type: 'object',
    properties: Object.entries(properties || {}).reduce((acc, [name, prop]) => {
      acc[name] = transformProperty(prop);
      return acc;
    }, {}),
    required: required || [],
    ...rest,
  };
}

/**
 * Transforms a schema property to Mistral format
 * @param {Object} prop - Property definition
 * @returns {Object} - Mistral property definition
 */
function transformProperty(prop) {
  const { type, description, enum: enumValues, ...rest } = prop;

  // Handle arrays
  if (type === 'array') {
    return {
      type: 'array',
      description,
      items: prop.items ? transformProperty(prop.items) : {},
      ...rest,
    };
  }

  // Handle objects
  if (type === 'object' && prop.properties) {
    return {
      type: 'object',
      description,
      properties: Object.entries(prop.properties).reduce((acc, [name, p]) => {
        acc[name] = transformProperty(p);
        return acc;
      }, {}),
      ...rest,
    };
  }

  return {
    type: mapType(type),
    description,
    enum: enumValues,
    ...rest,
  };
}

/**
 * Maps type names between formats
 * @param {string} type - Type name
 * @returns {string} - Mapped type
 */
function mapType(type) {
  const typeMap = {
    integer: 'integer',
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    array: 'array',
    object: 'object',
  };
  return typeMap[type] || type;
}

/**
 * Transforms Mistral response to common format
 * @param {Object} mistralResponse - Raw Mistral response
 * @returns {Object} - Transformed response
 */
function transformResponse(mistralResponse) {
  const choice = mistralResponse.choices[0];
  const message = choice.message;

  const content = [];

  // Add text content
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Add tool calls
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type === 'function') {
        try {
          const input = JSON.parse(toolCall.function.arguments);
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        } catch (e) {
          // If we can't parse the arguments, still include the tool call
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: toolCall.function.arguments,
          });
        }
      }
    }
  }

  // Determine stop reason
  const stop_reason = choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;

  return {
    id: `mistral-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    usage: {
      input_tokens: mistralResponse.usage?.prompt_tokens || 0,
      output_tokens: mistralResponse.usage?.completion_tokens || 0,
    },
  };
}
