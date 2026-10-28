import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMcpSession } from './mcp-session.mjs';
import { buildToolDefs } from './tools.mjs';

const MAX_TURNS = 20;
const MAX_HISTORY_CHARS = 400_000;

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Conversation {
  constructor({ id, config }) {
    this.id = id;
    this.config = config;
    this.dir = path.join(config.workDir, id);
    /** @type {Array<Array<{role: string, content: any}>>} one array of messages per user turn */
    this.turns = [];
    this.busy = false;
    this.lastUsed = Date.now();
    this.mcp = null;
    this.tools = null;
    this.activeName = null;
    this.hasModel = false;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    this.mcp = await createMcpSession({ workDir: this.dir });
    this.tools = buildToolDefs(await this.mcp.listTools(), { readOnly: this.config.readOnly });
  }

  messages() {
    return this.turns.flat();
  }

  beginTurn(text) {
    this.turns.push([{ role: 'user', content: text }]);
    while (this.turns.length > MAX_TURNS || (this.turns.length > 1 && JSON.stringify(this.turns).length > MAX_HISTORY_CHARS)) {
      this.turns.shift();
    }
    return this.turns[this.turns.length - 1];
  }

  rollbackTurn(turn) {
    const index = this.turns.indexOf(turn);
    if (index >= 0) this.turns.splice(index, 1);
  }

  async unloadModel() {
    if (this.hasModel) await this.mcp.callTool('model_unload', { model_id: 'active' });
    this.hasModel = false;
    this.activeName = null;
  }

  async loadFromBuffer(buffer, name) {
    await this.unloadModel();
    const file = path.join(this.dir, 'active.ifc');
    await writeFile(file, buffer);
    const result = await this.mcp.callTool('model_load', { file_path: file, model_id: 'active' });
    if (result.isError) throw new Error(`Could not load the model: ${result.text}`);
    this.hasModel = true;
    this.activeName = name;
  }

  async dispose() {
    this.mcp?.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}

export class ConversationStore {
  constructor({ config }) {
    this.config = config;
    this.items = new Map();
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  async getOrCreate(id) {
    const existing = id ? this.items.get(id) : undefined;
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (this.items.size >= this.config.maxConversations) await this.sweep(true);
    if (this.items.size >= this.config.maxConversations) throw Object.assign(new Error('Too many active conversations, try again later.'), { status: 503 });
    const conversation = new Conversation({ id: id ?? randomUUID(), config: this.config });
    await conversation.init();
    this.items.set(conversation.id, conversation);
    return conversation;
  }

  async remove(id) {
    const conversation = this.items.get(id);
    if (!conversation || conversation.busy) return false;
    this.items.delete(id);
    await conversation.dispose();
    return true;
  }

  async sweep(oldestOnly = false) {
    const now = Date.now();
    const idle = [...this.items.values()].filter((c) => !c.busy && now - c.lastUsed > (oldestOnly ? 0 : this.config.conversationTtlMs));
    idle.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const conversation of oldestOnly ? idle.slice(0, 1) : idle) await this.remove(conversation.id);
  }

  async closeAll() {
    clearInterval(this.timer);
    for (const id of [...this.items.keys()]) {
      const conversation = this.items.get(id);
      this.items.delete(id);
      await conversation.dispose();
    }
  }
}
