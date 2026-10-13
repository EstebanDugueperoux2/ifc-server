/**
 * ifc-server - IFC Processing Server Client
 *
 * Re-exports the IFC-Lite server client for custom integrations.
 * See example.ts and example-stream.ts for usage examples.
 */

import { IfcServerClient } from '@ifc-lite/server-client';

export { IfcServerClient } from '@ifc-lite/server-client';
export type {
  ServerConfig,
  ParseResponse,
  ParquetParseResponse,
  StreamEvent,
  HealthResponse,
  MetadataResponse,
} from '@ifc-lite/server-client';

// Default server URL
export const DEFAULT_SERVER_URL = 'http://localhost:3001';

/**
 * Create a pre-configured client for the local Docker server.
 */
export function createLocalClient(options?: { timeout?: number }) {
  return new IfcServerClient({
    baseUrl: process.env.SERVER_URL || DEFAULT_SERVER_URL,
    timeout: options?.timeout ?? 300000,
  });
}
