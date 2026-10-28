// End-to-end: real embedded @ifc-lite/mcp, scripted fake AI provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp, loadConfig } from '../server.mjs';

const ASSISTANT_TOKEN = 'assistant-secret';
const API_KEY = 'sk-test-key';

let tmp, mock, mockUrl, app, base;
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
    ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_BASE_URL: mockUrl,
    ASSISTANT_API_TOKEN: ASSISTANT_TOKEN, WORK_DIR: path.join(tmp, 'work'),
    ASSISTANT_PROVIDER: 'anthropic',
  }));
  base = `http://127.0.0.1:${await listen(app.server)}`;
});

after(async () => {
  await app?.close();
  mock?.close();
  mock?.closeAllConnections?.();
  await rm(tmp, { recursive: true, force: true });
});

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
  const health = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(health.llmConfigured, true);
});

test('create a temporary model, then query and edit it in a follow-up turn', async () => {
  received.length = 0;
  script = (body, n) => {
    if (n === 1) return toolUse('create_model', hall, 'toolu_create');
    return answer('Created the hall.');
  };
  const first = await chat({ message: 'Create a 10x6 hall' });
  assert.equal(first.status, 200);
  const types = first.events.map((e) => e.type);
  assert.deepEqual(
    types,
    ['conversation', 'tool_use', 'tool_result', 'text', 'done'],
    JSON.stringify(first.events),
  );
  const conversationId = first.events[0].conversationId;
  // The API request carried the right credentials, a curated toolset and a cached system prompt.
  const request = received[0];
  assert.equal(request.headers['x-api-key'], API_KEY);
  const names = request.body.tools.map((t) => t.name);
  assert.ok(names.includes('create_model') && names.includes('query_entities'));
  for (const forbidden of ['model_load', 'model_save', 'export_ifc', 'run_flow', 'viewer_open', 'bcf_export']) assert.ok(!names.includes(forbidden), forbidden);
  assert.ok(request.body.tools.every((t) => !t.input_schema.properties?.model_id), 'model_id is hidden from the model');
  assert.match(request.body.system[1].text, /no model is loaded/);
  assert.match(lastToolResult(received[1].body).content, /Created and loaded "Hall é": 1 storey\(s\), 4 wall\(s\), 1 slab\(s\)/);

  // Follow-up: the same temporary model stays available in the conversation.
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
    return answer('Renamed.');
  };
  const second = await chat({ message: 'Rename the first wall', conversationId });
  assert.ok(!second.events.some((e) => e.type === 'error'), JSON.stringify(second.events));
  assert.match(received[0].body.system[1].text, /"Hall é" is loaded as "active" for this conversation/);
  assert.equal(received[0].body.messages.length, 5, 'history of the first turn is kept');
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
    ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_BASE_URL: mockUrl,
    WORK_DIR: path.join(tmp, 'work2'), ANTHROPIC_TIMEOUT_SEC: '1',
    ASSISTANT_PROVIDER: 'anthropic',
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
