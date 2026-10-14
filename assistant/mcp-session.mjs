// Embedded @ifc-lite/mcp server, driven in-process (no network, no stdio).
import { createMCPServer, InProcessTransport, DEFAULT_CONFIG, fullScope } from '@ifc-lite/mcp';

const MAX_RESULT_CHARS = 12_000;

export function truncate(text, max = MAX_RESULT_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]` : text;
}

/**
 * @param {{ workDir: string }} options  Only files under workDir can be read or written by MCP tools.
 */
export async function createMcpSession({ workDir }) {
  const server = createMCPServer({
    version: '0.1.0',
    scope: fullScope(),
    config: { ...DEFAULT_CONFIG, allowedPaths: [workDir], samplingEnabled: false, autoOpenViewer: false },
  });
  const transport = new InProcessTransport();
  await transport.connect(server);

  let nextId = 0;
  const rpc = (method, params) => transport.send({ jsonrpc: '2.0', id: ++nextId, method, params });

  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'ifc-assistant', version: '0.1.0' },
  });
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    async listTools() {
      const response = await rpc('tools/list');
      return response?.result?.tools ?? [];
    },
    /** @returns {Promise<{ isError: boolean, text: string }>} */
    async callTool(name, args) {
      const response = await rpc('tools/call', { name, arguments: args });
      if (response?.error) return { isError: true, text: `MCP error: ${response.error.message}` };
      const result = response?.result;
      const text = (result?.content ?? []).map((part) => part.text ?? '').join('\n');
      return { isError: Boolean(result?.isError), text: truncate(text) };
    },
    close() {
      transport.close();
    },
  };
}
