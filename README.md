# ifc-server

IFC processing server using [IFC-Lite](https://github.com/LTplus-AG/ifc-lite).

## Quick Start

```bash
# 1. Start the server
docker compose up -d

# 2. Install client dependencies
npm install

# 3. Run the example (replace with your IFC file)
npm run example ./your-model.ifc
```

## Features

| Feature | Description |
|---------|-------------|
| **Content-Addressable Cache** | Same file = instant response (no reprocessing) |
| **Parquet Format** | 15x smaller payloads than JSON |
| **Streaming** | Progressive geometry for large files |
| **Parallel Processing** | Multi-threaded geometry processing |

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Your App       │────▶│  IFC-Lite Server │────▶│  Cache      │
│  (TypeScript)   │◀────│  (Docker)        │◀────│  (Volume)   │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run example` | Basic parsing example |
| `npm run example:stream` | Streaming example for large files |
| `npm run server:start` | Start server in background |
| `npm run server:stop` | Stop server |
| `npm run server:logs` | View server logs |
| `npm run server:dev` | Start with debug logging |

## Configuration

Copy `.env.example` to `.env` to customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `MAX_FILE_SIZE_MB` | 500 | Max upload size |
| `WORKER_THREADS` | 4 | Parallel processing threads |
| `CACHE_MAX_AGE_DAYS` | 7 | Cache retention |

See `.env.example` for all options with documentation.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/health` | Health check |
| `POST /api/v1/parse` | Full parse (JSON response) |
| `POST /api/v1/parse/parquet` | Full parse (Parquet, 15x smaller) |
| `POST /api/v1/parse/parquet-stream` | Streaming parse (SSE + Parquet) |
| `GET /api/v1/cache/check/:hash` | Check if file is cached |

## Client Usage

### Basic Parse

```typescript
import { IfcServerClient } from '@ifc-lite/server-client';

const client = new IfcServerClient({
  baseUrl: 'http://localhost:3001'
});

const result = await client.parseParquet(ifcBuffer);
console.log(`Meshes: ${result.meshes.length}`);
```

### Streaming (Large Files)

```typescript
await client.parseParquetStream(ifcBuffer, (batch) => {
  // Render each batch immediately
  for (const mesh of batch.meshes) {
    scene.addMesh(mesh);
  }
});
```

### Cache-First Pattern

```typescript
// Client automatically:
// 1. Computes file hash locally
// 2. Checks server cache
// 3. Skips upload if cached (instant response!)
const result = await client.parseParquet(ifcBuffer);
```

## Production Deployment

### Railway / Render / Fly.io

The Docker image works on any container platform:

```bash
# Pull and run
docker pull ghcr.io/ltplus-ag/ifc-lite-server:latest
docker run -p 8080:8080 -v ifc-cache:/app/cache ghcr.io/ltplus-ag/ifc-lite-server
```

### Environment Variables

Set these in your deployment platform:

```
PORT=8080
MAX_FILE_SIZE_MB=500
WORKER_THREADS=4
CACHE_MAX_AGE_DAYS=30
RUST_LOG=info
```

## Learn More

- [IFC-Lite Documentation](https://ifclite.dev/docs/)
- [Server Guide](https://ifclite.dev/docs/guide/server/)
- [GitHub Repository](https://github.com/LTplus-AG/ifc-lite)

## Companion project

`ifc-viewer-webapp` is the browser viewer built on IFC-Lite. This repository runs the IFC-Lite processing server (Docker) and a TypeScript client (`@ifc-lite/server-client`).

## AI assistant

The `assistant` service powers the chat view of the webapp: the user describes what they want and a configured AI provider creates, queries and edits IFC models through tools.

```
browser (chat view) --SSE--> assistant --configured AI provider (tool use)
                                |-- embedded @ifc-lite/mcp server (in-process, 125 BIM tools, 34 exposed)
```

- Provider API keys stay on the server; the browser only talks to the assistant.
- `@ifc-lite/mcp` is embedded as a library rather than run as a separate server, so the assistant controls exactly what the model can do. Only query, edit and placement tools are exposed; nothing that takes a file path (`model_load`, `export_*`, `run_flow`...), no viewer, BCF or layer tools. MCP file access is also restricted to a per-conversation working directory.
- A `create_model` tool builds a new IFC4 model from storeys, walls, slabs and columns. Models and edits remain in the assistant's temporary conversation workspace and are removed when that conversation expires; they are not stored or sent to the viewer.
- Tool results are treated as untrusted data (entity names or properties may contain text aimed at the model); the system prompt says so, and the exposed toolset limits what such text could do.

### API

`POST /api/v1/chat` with `{ "conversationId"?, "message" }` answers with a `text/event-stream`; each `data:` line is a JSON event: `conversation`, `text`, `tool_use`, `tool_result`, `error`, `done`. `DELETE /api/v1/conversations/:id` forgets a conversation (idle ones expire after 30 minutes). Set `ASSISTANT_API_TOKEN` to require `Authorization: Bearer <token>`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required. Without it `/api/v1/chat` answers 503 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used |
| `ASSISTANT_API_TOKEN` | none | Bearer token for the assistant API (recommended) |
| `ASSISTANT_READ_ONLY` | `false` | Only offer query tools |
| `MAX_STEPS`, `MAX_TOKENS`, `ANTHROPIC_TIMEOUT_SEC` | `12`, `4096`, `120` | Tool-use rounds per message, answer length, upstream timeout |
| `CORS_ALLOWED_ORIGINS` | none | Origins allowed to call it directly from a browser |

The assistant is published on `127.0.0.1` only by default. Put it behind HTTPS and set its token before exposing it.

### Tests

`cd assistant && npm install && npm test` runs an end-to-end suite against the embedded MCP server, with a scripted fake AI provider (create, query, edit, tool restrictions, errors, timeouts).
