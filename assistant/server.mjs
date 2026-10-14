// AI assistant gateway.
//
//   POST   /api/v1/chat                  { conversationId?, message, modelId?, saveMode? } -> text/event-stream
//   DELETE /api/v1/conversations/:id     forget a conversation
//   GET    /api/v1/health
//
// Streamed events (one JSON object per `data:` line):
//   conversation { conversationId }  text { text }  tool_use { id, name, input }
//   tool_result { id, name, isError, summary }  model_saved { model }  error { message }  done {}
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runTurn } from './agent.mjs';
import { ConversationStore, ID_RE } from './conversation.mjs';
import { createStoreClient } from './store-client.mjs';

export function loadConfig(env = process.env) {
  const int = (key, fallback) => (env[key] ? Number(env[key]) : fallback);
  return {
    port: int('PORT', 8082),
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
    maxTokens: int('MAX_TOKENS', 4096),
    maxSteps: int('MAX_STEPS', 12),
    requestTimeoutMs: int('ANTHROPIC_TIMEOUT_SEC', 120) * 1000,
    storeUrl: env.STORE_URL ?? 'http://model-store:8081',
    storeToken: env.STORE_API_TOKEN ?? '',
    token: env.ASSISTANT_API_TOKEN ?? '',
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    workDir: env.WORK_DIR ?? path.join(os.tmpdir(), 'ifc-assistant'),
    readOnly: env.ASSISTANT_READ_ONLY === 'true',
    maxModelBytes: int('MAX_MODEL_MB', 100) * 1024 * 1024,
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

export async function createApp(config) {
  await mkdir(config.workDir, { recursive: true });
  const store = createStoreClient({ baseUrl: config.storeUrl, token: config.storeToken });
  const conversations = new ConversationStore({ config, store });

  function checkAuth(req) {
    if (config.token && req.headers.authorization !== `Bearer ${config.token}`) throw new HttpError(401, 'Unauthorized');
  }

  async function chat(req, res) {
    if (!config.apiKey) throw new HttpError(503, 'The assistant is not configured: set ANTHROPIC_API_KEY on the server.');
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) throw new HttpError(400, 'message is required');
    if (message.length > config.maxMessageChars) throw new HttpError(400, `message is too long (max ${config.maxMessageChars} characters)`);
    if (body.conversationId !== undefined && !ID_RE.test(String(body.conversationId))) throw new HttpError(400, 'Invalid conversationId');
    if (body.modelId !== undefined && body.modelId !== null && !ID_RE.test(String(body.modelId))) throw new HttpError(400, 'Invalid modelId');
    if (body.saveMode !== undefined && !['new', 'overwrite'].includes(body.saveMode)) throw new HttpError(400, 'Invalid saveMode');

    const conversation = await conversations.getOrCreate(body.conversationId);
    if (conversation.busy) throw new HttpError(409, 'A request is already running in this conversation');
    conversation.busy = true;
    conversation.saveMode = body.saveMode ?? 'new';

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
      await conversation.syncModel(body.modelId);
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
      if (url.pathname === '/api/v1/health') return json(res, 200, { status: 'ok', llmConfigured: Boolean(config.apiKey), model: config.model, readOnly: config.readOnly });
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
    console.log(`assistant listening on :${config.port} (model ${config.model}, ${config.apiKey ? 'API key set' : 'NO API KEY'}${config.token ? '' : ', no access token'})`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void app.close().then(() => process.exit(0)));
}
