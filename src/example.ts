/**
 * IFC-Lite Server Client Example
 *
 * This example demonstrates how to use the IFC-Lite server to parse IFC files.
 * The server handles heavy geometry processing, caching, and streaming.
 *
 * Prerequisites:
 *   1. Start the server: docker compose up -d
 *   2. Run this example: npm run example
 */

import { IfcServerClient } from '@ifc-lite/server-client';
import { readFileSync, existsSync } from 'fs';

// Server URL - matches docker-compose.yml port mapping
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

async function main() {
  // Initialize client
  const client = new IfcServerClient({
    baseUrl: SERVER_URL,
    timeout: 300000, // 5 minutes for large files
  });

  // Check server health
  console.log('Checking server health...');
  try {
    const health = await client.health();
    console.log(`Server status: ${health.status}`);
    console.log(`Server version: ${health.version || 'unknown'}`);
  } catch (error) {
    console.error('Failed to connect to server. Is it running?');
    console.error('Start it with: docker compose up -d');
    process.exit(1);
  }

  // Get IFC file path from command line or use default
  const ifcPath = process.argv[2];

  if (!ifcPath) {
    console.log(`
Usage: npm run example <path-to-ifc-file>

Example:
  npm run example ./model.ifc

The server will:
  1. Check if the file is already cached (instant response)
  2. If not cached, parse and process geometry
  3. Cache the result for future requests
  4. Return geometry data ready for rendering
`);
    return;
  }

  if (!existsSync(ifcPath)) {
    console.error(`File not found: ${ifcPath}`);
    process.exit(1);
  }

  // Read IFC file
  console.log(`\nParsing: ${ifcPath}`);
  const nodeBuffer = readFileSync(ifcPath);
  const buffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
  console.log(`File size: ${(nodeBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  // Parse with Parquet format (most efficient)
  console.log('\nSending to server...');
  const startTime = performance.now();

  try {
    // Check if Parquet is available (optional dependency)
    const parquetAvailable = await client.isParquetSupported();

    if (parquetAvailable) {
      console.log('Using Parquet format (15x smaller than JSON)');
      const result = await client.parseParquet(buffer);

      const elapsed = performance.now() - startTime;
      console.log(`\nParsing complete in ${elapsed.toFixed(0)}ms`);
      console.log(`  Cache key: ${result.cache_key.substring(0, 16)}...`);
      console.log(`  Meshes: ${result.meshes.length}`);
      console.log(`  Payload size: ${(result.parquet_stats.payload_size / 1024).toFixed(1)} KB`);
      console.log(`  Decode time: ${result.parquet_stats.decode_time_ms}ms`);

      if (result.stats) {
        console.log(`\nServer stats:`);
        console.log(`  Parse time: ${result.stats.parse_time_ms}ms`);
        console.log(`  Geometry time: ${result.stats.geometry_time_ms}ms`);
        console.log(`  Total triangles: ${result.stats.total_triangles}`);
      }

      // Show sample mesh data
      if (result.meshes.length > 0) {
        const mesh = result.meshes[0];
        console.log(`\nSample mesh:`);
        console.log(`  Express ID: ${mesh.express_id}`);
        console.log(`  Vertices: ${mesh.positions.length / 3}`);
        console.log(`  Triangles: ${mesh.indices.length / 3}`);
        console.log(`  Color: rgba(${mesh.color.join(', ')})`);
      }
    } else {
      // Fallback to JSON format
      console.log('Parquet not available, using JSON format');
      console.log('Install optional deps for smaller payloads: npm install parquet-wasm apache-arrow');

      const result = await client.parse(buffer);

      const elapsed = performance.now() - startTime;
      console.log(`\nParsing complete in ${elapsed.toFixed(0)}ms`);
      console.log(`  Cache key: ${result.cache_key.substring(0, 16)}...`);
      console.log(`  Meshes: ${result.meshes.length}`);
    }
  } catch (error) {
    console.error('Parse failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
