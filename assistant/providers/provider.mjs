// AI Provider abstraction interface
// This file was generated with the assistance of an AI coding tool.

/**
 * Interface for AI Provider clients
 * @typedef {Object} ProviderClient
 * @property {Function} createMessage - Creates a message/completion request
 */

/**
 * Configuration for an AI provider
 * @typedef {Object} ProviderConfig
 * @property {string} type - Provider type (e.g., 'anthropic', 'openai', 'mistral')
 * @property {string} apiKey - API key for authentication
 * @property {string} [baseUrl] - Base URL for the API
 * @property {string} [model] - Default model to use
 */

/**
 * Common message creation options
 * @typedef {Object} MessageOptions
 * @property {string} model - Model identifier
 * @property {number} maxTokens - Maximum tokens to generate
 * @property {Array<Object>} system - System messages/prompts
 * @property {Array<Object>} tools - Available tools for the model
 * @property {Array<Object>} messages - Conversation history
 */

/**
 * Response from message creation
 * @typedef {Object} MessageResponse
 * @property {string} id - Response ID
 * @property {string} type - Response type
 * @property {string} role - Role (e.g., 'assistant')
 * @property {Array<Object>} content - Content blocks (text, tool_use, etc.)
 * @property {string} stop_reason - Reason for stopping (e.g., 'end_turn', 'tool_use', 'max_tokens')
 * @property {number} [stop_sequence] - Optional stop sequence
 * @property {Object} [usage] - Token usage information
 */

export const ProviderTypes = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  MISTRAL: 'mistral',
  GOOGLE: 'google',
};

/**
 * Factory function to create a provider client based on configuration
 * @param {ProviderConfig} config - Provider configuration
 * @returns {ProviderClient} - Provider client instance
 */
export async function createProviderClient(config) {
  switch (config.type) {
    case ProviderTypes.ANTHROPIC:
      return await import('./anthropic.mjs').then((m) => m.createClient(config));
    case ProviderTypes.OPENAI:
      return await import('./openai.mjs').then((m) => m.createClient(config));
    case ProviderTypes.MISTRAL:
      return await import('./mistral.mjs').then((m) => m.createClient(config));
    case ProviderTypes.GOOGLE:
      return await import('./google.mjs').then((m) => m.createClient(config));
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/**
 * Validate provider configuration
 * @param {ProviderConfig} config - Configuration to validate
 * @returns {boolean} - Whether configuration is valid
 */
export function validateProviderConfig(config) {
  if (!config || !config.type) return false;
  if (!config.apiKey) return false;
  if (!Object.values(ProviderTypes).includes(config.type)) return false;
  return true;
}
