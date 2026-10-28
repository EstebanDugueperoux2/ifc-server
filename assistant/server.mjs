// AI assistant gateway.
//
//   POST   /api/v1/chat                  { conversationId?, message } -> text/event-stream
//   DELETE /api/v1/conversations/:id     forget a conversation
//   GET    /api/v1/health
//
// Streamed events (one JSON object per `data:` line):
//   conversation { conversationId }  text { text }  tool_use { id, name, input }
//   tool_result { id, name, isError, summary }  error { message }  done {}
// This file was generated with the assistance of an AI coding tool.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runTurn } from './agent.mjs';
import { ConversationStore, ID_RE } from './conversation.mjs';
import { createProviderClient, ProviderTypes } from './providers/provider.mjs';

export function loadConfig(env = process.env) {
  const int = (key, fallback) => (env[key] ? Number(env[key]) : fallback);
  return {
    port: int('PORT', 8082),
    // Primary provider configuration (defaults to OpenAI)
    provider: env.ASSISTANT_PROVIDER || 'openai',
    // Provider-specific base URLs
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    openaiBaseUrl: env.OPENAI_BASE_URL,
    mistralBaseUrl: env.MISTRAL_BASE_URL,
    googleBaseUrl: env.GOOGLE_BASE_URL,
    // Model configuration - will be determined by provider
    model: env.ANTHROPIC_MODEL || env.OPENAI_MODEL || env.MISTRAL_MODEL || env.GOOGLE_MODEL || env.MODEL || 'gpt-4',
    maxTokens: int('MAX_TOKENS', 4096),
    maxSteps: int('MAX_STEPS', 12),
    // Timeout can be provider-specific or generic
    requestTimeoutMs: int(`${env.ASSISTANT_PROVIDER || 'ANTHROPIC'}_TIMEOUT_SEC`, int('ANTHROPIC_TIMEOUT_SEC', 120)) * 1000,
    token: env.ASSISTANT_API_TOKEN ?? '',
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    workDir: env.WORK_DIR ?? path.join(os.tmpdir(), 'ifc-assistant'),
    readOnly: env.ASSISTANT_READ_ONLY === 'true',
    maxConversations: int('MAX_CONVERSATIONS', 50),
    conversationTtlMs: int('CONVERSATION_TTL_MIN', 30) * 60_000,
    maxMessageChars: int('MAX_MESSAGE_CHARS', 4000),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * Creates an AI provider client based on configuration
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} - Provider client
 */
async function createProvider(config) {
  // Get the provider type and corresponding configuration
  const providerType = config.provider;
  let apiKey;
  let baseUrl;
  let model;

  // Determine which API key, base URL, and model to use based on provider
  switch (providerType) {
    case ProviderTypes.ANTHROPIC:
      apiKey = process.env.ANTHROPIC_API_KEY || config.apiKey || '';
      baseUrl = process.env.ANTHROPIC_BASE_URL || config.anthropicBaseUrl || 'https://api.anthropic.com';
      model = process.env.ANTHROPIC_MODEL || config.model || 'claude-sonnet-5-5';
      break;
    case ProviderTypes.OPENAI:
      apiKey = process.env.OPENAI_API_KEY || config.apiKey || '';
      baseUrl = process.env.OPENAI_BASE_URL || config.openaiBaseUrl || 'https://api.openai.com/v1';
      model = process.env.OPENAI_MODEL || config.model || 'gpt-4';
      break;
    case ProviderTypes.MISTRAL:
      apiKey = process.env.MISTRAL_API_KEY || config.apiKey || '';
      baseUrl = process.env.MISTRAL_BASE_URL || config.mistralBaseUrl || 'https://api.mistral.ai/v1';
      model = process.env.MISTRAL_MODEL || config.model || 'mistral-large';
      break;
    case ProviderTypes.GOOGLE:
      apiKey = process.env.GOOGLE_API_KEY || config.apiKey || '';
      baseUrl = process.env.GOOGLE_BASE_URL || config.googleBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
      model = process.env.GOOGLE_MODEL || config.model || 'gemini-pro';
      break;
    default:
      // Default to OpenAI
      apiKey = process.env.OPENAI_API_KEY || config.apiKey || '';
      baseUrl = process.env.OPENAI_BASE_URL || config.openaiBaseUrl || 'https://api.openai.com/v1';
      model = process.env.OPENAI_MODEL || config.model || 'gpt-4';
  }

  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${providerType}`);
  }

  return createProviderClient({
    type: providerType,
    apiKey,
    baseUrl,
  });
}

export async function createApp(config) {
  await mkdir(config.workDir, { recursive: true });
  const conversations = new ConversationStore({ config });

  // Create provider client for all conversations to share
  let provider;
  try {
    provider = await createProvider(config);
  } catch (error) {
    console.error('Failed to create provider client:', error.message);
    // Continue without provider - will fail on first chat request
  }

  function checkAuth(req) {
    if (config.token && req.headers.authorization !== `Bearer ${config.token}`) throw new HttpError(401, 'Unauthorized');
  }

  async function chat(req, res) {
    if (!provider) throw new HttpError(503, 'The assistant is not configured: no API key set for the selected provider.');
    
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new HttpError(400, 'message is required');
    if (message.length > config.maxMessageChars) throw new HttpError(400, `message is too long (max ${config.maxMessageChars} characters)`);
    if (body.conversationId !== undefined && !ID_RE.test(String(body.conversationId))) throw new HttpError(400, 'Invalid conversationId');

    const conversation = await conversations.getOrCreate(body.conversationId);
    if (conversation.busy) throw new HttpError(409, 'A request is already running in this conversation');
    conversation.busy = true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const emit = (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    try {
      emit({ type: 'conversation', conversationId: conversation.id });
      // Pass provider to conversation for use in agent
      conversation.provider = provider;
      conversation.providerConfig = {
        model: config.model,
        maxTokens: config.maxTokens,
        requestTimeoutMs: config.requestTimeoutMs,
      };
      await runTurn({ conversation, text: message, emit, signal: abort.signal });
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error('chat error:', error instanceof Error ? error.message : error);
        emit({ type: 'error', message: error instanceof Error ? error.message : 'Unexpected error' });
      }
    } finally {
      conversation.busy = false;
      conversation.lastUsed = Date.now();
      emit({ type: 'done' });
      res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    if (req.method === 'OPTIONS') return json(res, 204);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.pathname === '/api/v1/health') {
        return json(res, 200, {
          status: 'ok',
          llmConfigured: Boolean(provider),
          model: config.model,
          provider: config.provider,
          readOnly: config.readOnly,
        });
      }
      checkAuth(req);
      if (req.method === 'POST' && url.pathname === '/api/v1/chat') return await chat(req, res);
      if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'conversations' && parts[3]) {
        if (!ID_RE.test(parts[3])) throw new HttpError(400, 'Invalid id');
        await conversations.remove(parts[3]);
        return json(res, 204);
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error?.status ?? 500);
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : error.message });
      else res.end();
    }
  });

  return {
    server,
    conversations,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await conversations.closeAll();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const app = await createApp(config);
  app.server.listen(config.port, () => {
    console.log(`assistant listening on :${config.port} (provider: ${config.provider}, model: ${config.model}, ${config.apiKey ? 'API key set' : 'NO API KEY'}${config.token ? '' : ', no access token'})`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void app.close().then(() => process.exit(0)));
}
