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

## Model store

The IFC-Lite server only parses files and caches the results; it does not keep your `.ifc` files. The `model-store` service (`model-store/server.mjs`, no dependencies) fills that gap. It is started by `docker compose up -d` on port 3002 and persists files in the `ifc-models` volume.

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/models` | List stored models (`id`, `name`, `size`, `createdAt`) |
| POST | `/api/v1/models` | Store a model: raw IFC body, name in the `X-Model-Name` header (URL-encoded) |
| GET | `/api/v1/models/:id` | Download the IFC file |
| DELETE | `/api/v1/models/:id` | Delete a model |
| GET | `/api/v1/health` | Health check |

Only STEP/IFC content is accepted (`ISO-10303-21` header). Set `STORE_API_TOKEN` to require `Authorization: Bearer <token>`.
