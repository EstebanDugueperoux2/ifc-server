// Google Gemini API client implementation
// This file was generated with the assistance of an AI coding tool.

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a Google Gemini API client
 * @param {Object} config - Configuration object
 * @param {string} config.apiKey - Google API key
 * @param {string} [config.baseUrl='https://generativelanguage.googleapis.com/v1beta'] - Base URL for the API
 * @returns {Object} - Client with createMessage method
 */
export function createClient({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' }) {
  return {
    /**
     * Creates a message using Google Gemini API
     * @param {Object} options - Message options
     * @param {AbortSignal} [options.signal] - Abort signal
     * @param {number} [options.timeoutMs=120000] - Request timeout
     * @param {Object} options.body - Request body (Anthropic format, will be transformed)
     * @returns {Promise<Object>} - Message response in common format
     */
    async createMessage({ signal, timeoutMs = 120_000, body }) {
      // Transform Anthropic-style request to Google Gemini format
      const googleBody = transformRequest(body);

      // Build URL with model parameter
      const model = body.model || 'gemini-pro';
      const url = `${baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;

      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${url}?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(googleBody),
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
        throw new Error(`Google API error (${response.status}): ${detail}`);
      }
    },
  };
}

/**
 * Transforms Anthropic-style request to Google Gemini format
 * @param {Object} anthropicBody - Request in Anthropic format
 * @returns {Object} - Request in Google format
 */
function transformRequest(anthropicBody) {
  const { max_tokens, system, tools, messages } = anthropicBody;

  const contents = [];

  // Add system prompt as the first message
  if (system && system.length > 0) {
    const systemText = system
      .filter((s) => s.type === 'text')
      .map((s) => s.text)
      .join('\n');
    if (systemText) {
      contents.push({
        role: 'user',
        parts: [{ text: systemText }],
      });
    }
  }

  // Add conversation messages
  for (const msg of messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const content = msg.content;

    const parts = [];

    // Handle different content types
    if (Array.isArray(content)) {
      for (const block of content) {
        switch (block.type) {
          case 'text':
            parts.push({ text: block.text });
            break;
          case 'tool_result':
            // For tool results, we add them as text
            parts.push({ text: `[Tool result for ${block.name || 'unknown'}]: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {})}` });
            break;
        }
      }
    } else if (typeof content === 'string') {
      parts.push({ text: content });
    }

    // Only add non-empty messages
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  // Map tools to Google function declarations
  // Note: Google's function calling works differently - it's more limited
  // For now, we'll just include tools in the generation config if available
  const generationConfig = {};
  if (max_tokens) {
    generationConfig.maxOutputTokens = max_tokens;
  }

  return {
    contents,
    generationConfig,
    // Note: Google's function calling is different and requires advance setup
    // This is a simplified implementation
    ...(tools && tools.length > 0 ? { tools: mapToolsToGoogle(tools) } : {}),
  };
}

/**
 * Maps Anthropic tools to Google function declarations
 * @param {Array<Object>} tools - Array of tool definitions
 * @returns {Array<Object>} - Google-style function declarations
 */
function mapToolsToGoogle(tools) {
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description || '',
        parameters: transformSchema(tool.input_schema),
      },
    ],
  }));
}

/**
 * Transforms JSON schema to Google format
 * @param {Object} schema - Input schema
 * @returns {Object} - Google schema object
 */
function transformSchema(schema) {
  if (!schema) return { type: 'OBJECT', properties: {} };

  const { properties, required, ...rest } = schema;

  return {
    type: 'OBJECT',
    properties: Object.entries(properties || {}).reduce((acc, [name, prop]) => {
      acc[name] = transformProperty(prop);
      return acc;
    }, {}),
    required: required || [],
    ...rest,
  };
}

/**
 * Transforms a schema property to Google format
 * @param {Object} prop - Property definition
 * @returns {Object} - Google property definition
 */
function transformProperty(prop) {
  const { type, description, enum: enumValues, ...rest } = prop;

  // Handle arrays
  if (type === 'array') {
    return {
      type: 'ARRAY',
      description,
      items: prop.items ? transformProperty(prop.items) : { type: 'STRING' },
      ...rest,
    };
  }

  // Handle objects
  if (type === 'object' && prop.properties) {
    return {
      type: 'OBJECT',
      description,
      properties: Object.entries(prop.properties).reduce((acc, [name, p]) => {
        acc[name] = transformProperty(p);
        return acc;
      }, {}),
      ...rest,
    };
  }

  // Map types to Google's uppercase types
  const typeMap = {
    integer: 'INTEGER',
    number: 'NUMBER',
    string: 'STRING',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
  };

  return {
    type: typeMap[type] || 'STRING',
    description,
    ...(enumValues ? { enum: enumValues } : {}),
    ...rest,
  };
}

/**
 * Transforms Google Gemini response to common format
 * @param {Object} googleResponse - Raw Google response
 * @returns {Object} - Transformed response
 */
function transformResponse(googleResponse) {
  const content = [];

  // Extract the main content from the response
  const candidates = googleResponse.candidates || [];
  const candidate = candidates[0];

  if (candidate && candidate.content) {
    for (const part of candidate.content.parts || []) {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      // Handle function calls if present
      if (part.functionCall) {
        const fc = part.functionCall;
        try {
          const input = fc.args ? JSON.parse(fc.args) : {};
          content.push({
            type: 'tool_use',
            id: fc.id || `call-${Date.now()}`,
            name: fc.name,
            input,
          });
        } catch (e) {
          content.push({
            type: 'tool_use',
            id: fc.id || `call-${Date.now()}`,
            name: fc.name,
            input: fc.args || {},
          });
        }
      }
    }
  }

  // Determine stop reason
  const stop_reason = candidate?.finishReason === 'STOP' ? 'end_turn' : candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : candidate?.finishReason || 'end_turn';

  return {
    id: `gemini-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    usage: {
      input_tokens: googleResponse.usageMetadata?.promptTokenCount || 0,
      output_tokens: googleResponse.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}
