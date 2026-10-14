// End-to-end: real model-store + real embedded @ifc-lite/mcp, scripted fake Anthropic API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createApp, loadConfig } from '../server.mjs';
import { buildModel } from '../create-model.mjs';

const STORE_TOKEN = 'store-secret';
const ASSISTANT_TOKEN = 'assistant-secret';
const API_KEY = 'sk-test-key';

let tmp, storeProc, storeUrl, mock, mockUrl, app, base;
let script = () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
const received = [];

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
};

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'assistant-e2e-'));
  const storePort = await freePort();
  storeUrl = `http://127.0.0.1:${storePort}`;
  storeProc = spawn('node', [new URL('../../model-store/server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(storePort), DATA_DIR: path.join(tmp, 'store'), STORE_API_TOKEN: STORE_TOKEN },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${storeUrl}/api/v1/health`)).ok) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ headers: req.headers, body });
    try {
      const reply = await script(body, received.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, usage: { input_tokens: 1, output_tokens: 1 }, ...reply }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
    }
  });
  mockUrl = `http://127.0.0.1:${await listen(mock)}`;

  app = await createApp(loadConfig({
    ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_BASE_URL: mockUrl, STORE_URL: storeUrl, STORE_API_TOKEN: STORE_TOKEN,
    ASSISTANT_API_TOKEN: ASSISTANT_TOKEN, WORK_DIR: path.join(tmp, 'work'),
  }));
  base = `http://127.0.0.1:${await listen(app.server)}`;
});

after(async () => {
  await app?.close();
  mock?.close();
  mock?.closeAllConnections?.();
  storeProc?.kill();
  await rm(tmp, { recursive: true, force: true });
});

const storeApi = (suffix = '', init = {}) => fetch(`${storeUrl}/api/v1/models${suffix}`, { ...init, headers: { Authorization: `Bearer ${STORE_TOKEN}`, ...(init.headers ?? {}) } });

async function chat(payload, token = ASSISTANT_TOKEN) {
  const res = await fetch(`${base}/api/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return { status: res.status, body: await res.json(), events: [] };
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, events };
}

const toolUse = (name, input, id = `toolu_${Math.random().toString(36).slice(2, 8)}`) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const answer = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const lastToolResult = (body) => body.messages.at(-1).content[0];

const hall = { name: 'Hall é', storeys: [{ name: 'Ground', walls: [{ start: [0, 0], end: [10, 0] }, { start: [10, 0], end: [10, 6] }, { start: [10, 6], end: [0, 6] }, { start: [0, 6], end: [0, 0] }], slabs: [{ origin: [0, 0, -0.2], width: 10, depth: 6 }] }] };

test('auth, validation and configuration errors', async () => {
  assert.equal((await chat({ message: 'hi' }, 'wrong')).status, 401);
  assert.equal((await chat({ message: '  ' })).status, 400);
  assert.equal((await chat({ message: 'x'.repeat(5000) })).status, 400);
  assert.equal((await chat({ message: 'hi', conversationId: '../../etc' })).status, 400);
  assert.equal((await chat({ message: 'hi', modelId: 'nope' })).status, 400);
  assert.equal((await chat({ message: 'hi', saveMode: 'destroy' })).status, 400);
  const health = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(health.llmConfigured, true);
});

test('create a model, save it, then query and edit it in a follow-up turn', async () => {
  received.length = 0;
  script = (body, n) => {
    if (n === 1) return toolUse('create_model', hall, 'toolu_create');
    if (n === 2) return toolUse('save_to_library', {}, 'toolu_save');
    return answer('Created the hall.');
  };
  const first = await chat({ message: 'Create a 10x6 hall' });
  assert.equal(first.status, 200);
  const types = first.events.map((e) => e.type);
  assert.deepEqual(
    types,
    ['conversation', 'tool_use', 'tool_result', 'tool_use', 'model_saved', 'tool_result', 'text', 'done'],
    JSON.stringify(first.events),
  );
  const conversationId = first.events[0].conversationId;
  const saved = first.events.find((e) => e.type === 'model_saved').model;
  assert.equal(saved.name, 'Hall é');

  // The API request carried the right credentials, a curated toolset and a cached system prompt.
  const request = received[0];
  assert.equal(request.headers['x-api-key'], API_KEY);
  const names = request.body.tools.map((t) => t.name);
  assert.ok(names.includes('create_model') && names.includes('save_to_library') && names.includes('query_entities'));
  for (const forbidden of ['model_load', 'model_save', 'export_ifc', 'run_flow', 'viewer_open', 'bcf_export']) assert.ok(!names.includes(forbidden), forbidden);
  assert.ok(request.body.tools.every((t) => !t.input_schema.properties?.model_id), 'model_id is hidden from the model');
  assert.match(request.body.system[1].text, /no model is loaded/);
  assert.match(lastToolResult(received[1].body).content, /Created and loaded "Hall é": 1 storey\(s\), 4 wall\(s\), 1 slab\(s\)/);

  // Stored as a valid IFC.
  const listed = await (await storeApi()).json();
  assert.equal(listed.length, 1);
  const stored = await (await storeApi(`/${saved.id}`)).text();
  assert.equal((stored.match(/IFCWALL\(/g) ?? []).length, 4);

  // Follow-up: the webapp reopened the saved model; edit a wall and save again (updates the working copy).
  received.length = 0;
  let wallId;
  script = (body, n) => {
    if (n === 1) return toolUse('query_entities', { type: 'IfcWall' }, 'toolu_q');
    if (n === 2) {
      const text = lastToolResult(body).content;
      assert.match(text, /Found 4 matching entities/);
      wallId = Number(text.match(/IfcWall #(\d+)/)[1]);
      return toolUse('entity_set_attribute', { express_id: wallId, attribute: 'Name', value: 'Mur Nord' }, 'toolu_set');
    }
    if (n === 3) return toolUse('save_to_library', {}, 'toolu_save2');
    return answer('Renamed.');
  };
  const second = await chat({ message: 'Rename the first wall', conversationId, modelId: saved.id });
  assert.ok(!second.events.some((e) => e.type === 'error'), JSON.stringify(second.events));
  assert.match(received[0].body.system[1].text, /"Hall é" is loaded as "active"/);
  // First turn = user, assistant(tool_use), user(tool_result) x2, assistant(text): 6 messages, plus the new question.
  assert.equal(received[0].body.messages.length, 7, 'history of the first turn is kept');
  const after2 = await (await storeApi()).json();
  assert.equal(after2.length, 1, 'working copy updated in place, no duplicate');
  assert.ok(after2[0].updatedAt);
  assert.match(await (await storeApi(`/${saved.id}`)).text(), /Mur Nord/);
});

test('save modes: "new" forks the opened model, "overwrite" updates it', async () => {
  const original = await (await storeApi('', { method: 'POST', headers: { 'X-Model-Name': 'Original' }, body: buildModel(hall).content })).json();
  const edit = (name) => (body, n) => (n === 1 ? toolUse('query_entities', { type: 'IfcWall', limit: 1 }) : n === 2
    ? toolUse('entity_set_attribute', { express_id: Number(lastToolResult(body).content.match(/#(\d+)/)[1]), attribute: 'Name', value: name })
    : n === 3 ? toolUse('save_to_library', {}) : answer('done'));

  received.length = 0;
  script = edit('Forked');
  const forked = await chat({ message: 'edit', modelId: original.id, saveMode: 'new' });
  const copy = forked.events.find((e) => e.type === 'model_saved').model;
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, 'Original (assistant)');
  assert.doesNotMatch(await (await storeApi(`/${original.id}`)).text(), /Forked/, 'original untouched');

  received.length = 0;
  script = edit('Overwritten');
  const over = await chat({ message: 'edit', modelId: original.id, saveMode: 'overwrite' });
  assert.equal(over.events.find((e) => e.type === 'model_saved').model.id, original.id);
  assert.match(await (await storeApi(`/${original.id}`)).text(), /Overwritten/);
});

test('the model cannot reach files or unlisted tools', async () => {
  const attempts = [['model_load', { file_path: '/etc/passwd' }], ['export_ifc', { file_path: '/tmp/x.ifc' }], ['viewer_open', {}], ['does_not_exist', {}]];
  let i = 0;
  script = (body, n) => (n === 1 ? toolUse(...attempts[i++ % 4]) : answer('x'));
  for (let k = 0; k < attempts.length; k += 1) {
    received.length = 0;
    const r = await chat({ message: `try ${k}` });
    const result = r.events.find((e) => e.type === 'tool_result');
    assert.equal(result.isError, true);
    assert.match(result.summary, /Unknown or unavailable tool/);
  }
});

test('tool errors are returned to the model, not thrown', async () => {
  received.length = 0;
  script = (body, n) => (n === 1 ? toolUse('create_model', { name: 'Bad', storeys: [{ walls: [{ start: [0, 0], end: [0, 0] }] }] }, 'toolu_bad') : n === 2 ? (assert.equal(lastToolResult(body).is_error, true), answer('Fixed.')) : answer('?'));
  const r = await chat({ message: 'bad model' });
  assert.ok(!r.events.some((e) => e.type === 'error'));
  assert.match(r.events.find((e) => e.type === 'tool_result').summary, /identical start and end/);
});

test('upstream failure is reported and the broken turn is rolled back', async () => {
  received.length = 0;
  script = () => answer('hi');
  const convId = (await chat({ message: 'hello' })).events[0].conversationId;
  script = () => { throw new Error('boom'); };
  const failed = await chat({ message: 'will fail', conversationId: convId });
  assert.ok(failed.events.some((e) => e.type === 'error'));
  script = () => answer('recovered');
  received.length = 0;
  await chat({ message: 'again', conversationId: convId });
  const roles = received[0].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user'], 'failed turn removed from history');
  assert.equal((await fetch(`${base}/api/v1/conversations/${convId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ASSISTANT_TOKEN}` } })).status, 204);
});

test('an unresponsive upstream times out instead of hanging', async () => {
  const slowApp = await createApp(loadConfig({
    ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_BASE_URL: mockUrl, STORE_URL: storeUrl, STORE_API_TOKEN: STORE_TOKEN,
    WORK_DIR: path.join(tmp, 'work2'), ANTHROPIC_TIMEOUT_SEC: '1',
  }));
  const port = await listen(slowApp.server);
  script = () => new Promise(() => {}); // never answers
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
  const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.ok(events.some((e) => e.type === 'error'), JSON.stringify(events));
  assert.equal(events.at(-1).type, 'done');
  await slowApp.close();
});

test('a second request in a busy conversation is refused', async () => {
  received.length = 0;
  let release;
  script = () => new Promise((resolve) => { release = () => resolve(answer('slow')); });
  const convId = '11111111-2222-4333-8444-555555555555';
  const slow = chat({ message: 'slow one', conversationId: convId });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await chat({ message: 'second', conversationId: convId })).status, 409);
  release();
  assert.ok((await slow).events.some((e) => e.type === 'done'));
});
