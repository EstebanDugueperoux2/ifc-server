// OpenAI Chat Completions API client implementation
// This file was generated with the assistance of an AI coding tool.

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates an OpenAI Chat Completions API client
 * @param {Object} config - Configuration object
 * @param {string} config.apiKey - OpenAI API key
 * @param {string} [config.baseUrl='https://api.openai.com/v1'] - Base URL for the API
 * @returns {Object} - Client with createMessage method
 */
export function createClient({ apiKey, baseUrl = 'https://api.openai.com/v1' }) {
  return {
    /**
     * Creates a message using OpenAI Chat Completions API
     * @param {Object} options - Message options
     * @param {AbortSignal} [options.signal] - Abort signal
     * @param {number} [options.timeoutMs=120000] - Request timeout
     * @param {Object} options.body - Request body (Anthropic format, will be transformed)
     * @returns {Promise<Object>} - Message response in common format
     */
    async createMessage({ signal, timeoutMs = 120_000, body }) {
      // Transform Anthropic-style request to OpenAI format
      const openaiBody = transformRequest(body);

      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(openaiBody),
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
        throw new Error(`OpenAI API error (${response.status}): ${detail}`);
      }
    },
  };
}

/**
 * Transforms Anthropic-style request to OpenAI Chat Completions format
 * @param {Object} anthropicBody - Request in Anthropic format
 * @returns {Object} - Request in OpenAI format
 */
function transformRequest(anthropicBody) {
  const { model, max_tokens, system, tools, messages } = anthropicBody;

  // Map tools to OpenAI function format
  const openaiTools = tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: transformSchema(tool.input_schema),
    },
  })) || [];

  // Map messages to OpenAI format
  const openaiMessages = [];

  // Add system prompt (Anthropic allows multiple system messages, OpenAI only one)
  if (system && system.length > 0) {
    const systemText = system
      .filter((s) => s.type === 'text')
      .map((s) => s.text)
      .join('\n');
    if (systemText) {
      openaiMessages.push({ role: 'system', content: systemText });
    }
  }

  // Add conversation messages
  for (const msg of messages || []) {
    const role = msg.role;
    const content = msg.content;

    // Handle different content types
    if (Array.isArray(content)) {
      // Anthropic messages can have multiple content blocks
      const textParts = [];
      const toolCalls = [];

      for (const block of content) {
        switch (block.type) {
          case 'text':
            textParts.push(block.text);
            break;
          case 'tool_result':
            // Map tool results to OpenAI format
            toolCalls.push({
              id: block.tool_use_id,
              type: 'function',
              function: {
                name: block.name || 'unknown',
                arguments: JSON.stringify(block.content || {}),
              },
            });
            break;
        }
      }

      const openaiMsg = { role, content: textParts.join('') };
      if (toolCalls.length > 0 && role === 'user') {
        openaiMsg.tool_calls = toolCalls;
      }
      openaiMessages.push(openaiMsg);
    } else if (typeof content === 'string') {
      openaiMessages.push({ role, content });
    }
  }

  return {
    model,
    max_tokens,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    messages: openaiMessages,
    // OpenAI requires tool_choice for function calling
    ...(openaiTools.length > 0 ? { tool_choice: 'auto' } : {}),
  };
}

/**
 * Transforms JSON schema to OpenAI function parameters format
 * @param {Object} schema - Input schema
 * @returns {Object} - OpenAI parameters object
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
 * Transforms a schema property to OpenAI format
 * @param {Object} prop - Property definition
 * @returns {Object} - OpenAI property definition
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
 * Transforms OpenAI response to common format
 * @param {Object} openaiResponse - Raw OpenAI response
 * @returns {Object} - Transformed response
 */
function transformResponse(openaiResponse) {
  const choice = openaiResponse.choices[0];
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
    id: `chatcmpl-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}
