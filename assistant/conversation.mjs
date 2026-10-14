import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMcpSession } from './mcp-session.mjs';
import { buildToolDefs } from './tools.mjs';

const MAX_TURNS = 20;
const MAX_HISTORY_CHARS = 400_000;

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Conversation {
  constructor({ id, config, store }) {
    this.id = id;
    this.config = config;
    this.store = store;
    this.dir = path.join(config.workDir, id);
    /** @type {Array<Array<{role: string, content: any}>>} one array of messages per user turn */
    this.turns = [];
    this.busy = false;
    this.lastUsed = Date.now();
    this.mcp = null;
    this.tools = null;
    /** Stored model currently loaded as 'active' (null: nothing, or an unsaved model made by create_model). */
    this.activeStoredId = null;
    this.activeName = null;
    this.hasModel = false;
    /** Library entry created by the assistant in this conversation (later saves update it). */
    this.workingCopyId = null;
    this.saveMode = 'new';
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
    this.activeStoredId = null;
    this.activeName = null;
  }

  async loadFromBuffer(buffer, { storedId, name }) {
    await this.unloadModel();
    const file = path.join(this.dir, 'active.ifc');
    await writeFile(file, buffer);
    const result = await this.mcp.callTool('model_load', { file_path: file, model_id: 'active' });
    if (result.isError) throw new Error(`Could not load the model: ${result.text}`);
    this.hasModel = true;
    this.activeStoredId = storedId;
    this.activeName = name;
  }

  /** Aligns the session with the model the user has open in the viewer. */
  async syncModel(modelId) {
    if (modelId === undefined) return;
    if (modelId === null) {
      if (this.activeStoredId !== null) await this.unloadModel();
      if (this.activeStoredId === null && this.hasModel === false) this.workingCopyId = null;
      return;
    }
    if (modelId === this.activeStoredId && this.hasModel) return;
    const entry = (await this.store.list()).find((model) => model.id === modelId);
    if (!entry) throw new Error('The selected model no longer exists in the library.');
    if (entry.size > this.config.maxModelBytes) {
      throw new Error(`This model is too large for the assistant (${Math.round(entry.size / 1e6)} MB, limit ${Math.round(this.config.maxModelBytes / 1e6)} MB).`);
    }
    await this.loadFromBuffer(await this.store.download(modelId), { storedId: modelId, name: entry.name });
    // Opening a model the assistant did not create ends the link with its previous working copy.
    if (modelId !== this.workingCopyId) this.workingCopyId = null;
  }

  /** Exports the active model and stores it according to the user's save mode. */
  async save(requestedName) {
    if (!this.hasModel) throw new Error('There is no active model to save.');
    const file = path.join(this.dir, 'export.ifc');
    const exported = await this.mcp.callTool('export_ifc', { model_id: 'active', file_path: file });
    if (exported.isError) throw new Error(`Export failed: ${exported.text}`);
    const content = await readFile(file);

    const baseName = (this.activeName ?? 'Model').replace(/ \(assistant\)$/, '');
    let meta;
    if (this.saveMode === 'overwrite' && this.activeStoredId) {
      meta = await this.store.replace(this.activeStoredId, content);
    } else if (this.workingCopyId) {
      meta = await this.store.replace(this.workingCopyId, content);
    } else {
      const name = (requestedName && requestedName.trim()) || (this.activeStoredId ? `${baseName} (assistant)` : baseName);
      meta = await this.store.create(name, content);
      this.workingCopyId = meta.id;
    }
    this.activeStoredId = meta.id;
    this.activeName = meta.name;
    return meta;
  }

  async dispose() {
    this.mcp?.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}

export class ConversationStore {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
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
    const conversation = new Conversation({ id: id ?? randomUUID(), config: this.config, store: this.store });
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
