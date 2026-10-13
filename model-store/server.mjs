// Minimal IFC model storage service (no dependencies).
//
//   GET    /api/v1/models        -> [{ id, name, size, createdAt }]
//   POST   /api/v1/models        -> body: raw IFC text, header X-Model-Name  -> 201 { id, ... }
//   GET    /api/v1/models/:id    -> the IFC file
//   DELETE /api/v1/models/:id
//   GET    /api/v1/health
//
// Files live in DATA_DIR as <id>.ifc with a <id>.json metadata sidecar.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8081);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const MAX_BYTES = Number(process.env.MAX_FILE_SIZE_MB ?? 500) * 1024 * 1024;
const TOKEN = process.env.STORE_API_TOKEN ?? '';
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

await mkdir(DATA_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cleanName(raw) {
  const decoded = (() => {
    try {
      return decodeURIComponent(raw ?? '');
    } catch {
      return '';
    }
  })();
  // eslint-disable-next-line no-control-regex
  const name = decoded.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim().slice(0, 120);
  return name || 'model';
}

function checkAuth(req) {
  if (!TOKEN) return;
  const given = req.headers.authorization ?? '';
  if (given !== `Bearer ${TOKEN}`) throw new HttpError(401, 'Unauthorized');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new HttpError(413, 'File too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function listModels() {
  const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      items.push(JSON.parse(await readFile(path.join(DATA_DIR, f), 'utf8')));
    } catch {
      /* skip unreadable metadata */
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // api v1 models [id]

  if (url.pathname === '/api/v1/health') return send(res, 200, { status: 'ok' });
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'models') {
    throw new HttpError(404, 'Not found');
  }
  checkAuth(req);

  const id = parts[3];
  if (id !== undefined && !ID_RE.test(id)) throw new HttpError(400, 'Invalid id');

  if (id === undefined) {
    if (req.method === 'GET') return send(res, 200, await listModels());
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.length === 0) throw new HttpError(400, 'Empty body');
      if (!body.subarray(0, 64).toString('utf8').trimStart().startsWith('ISO-10303-21')) {
        throw new HttpError(415, 'Not an IFC (STEP) file');
      }
      const newId = randomUUID();
      const meta = {
        id: newId,
        name: cleanName(req.headers['x-model-name']),
        size: body.length,
        createdAt: new Date().toISOString(),
      };
      const tmp = path.join(DATA_DIR, `${newId}.ifc.tmp`);
      await writeFile(tmp, body);
      await rename(tmp, path.join(DATA_DIR, `${newId}.ifc`));
      await writeFile(path.join(DATA_DIR, `${newId}.json`), JSON.stringify(meta));
      return send(res, 201, meta);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const ifcPath = path.join(DATA_DIR, `${id}.ifc`);
  const exists = await stat(ifcPath).then(() => true, () => false);
  if (!exists) throw new HttpError(404, 'Model not found');

  if (req.method === 'GET') {
    return send(res, 200, await readFile(ifcPath), { 'Content-Type': 'application/x-step' });
  }
  if (req.method === 'DELETE') {
    await rm(ifcPath, { force: true });
    await rm(path.join(DATA_DIR, `${id}.json`), { force: true });
    return send(res, 204, '');
  }
  throw new HttpError(405, 'Method not allowed');
}

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Model-Name');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      // Needed when the webapp runs with Cross-Origin-Embedder-Policy: require-corp.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204, '');
    try {
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : error.message });
    }
  })
  .listen(PORT, () => console.log(`model-store listening on :${PORT}, data in ${DATA_DIR}`));
