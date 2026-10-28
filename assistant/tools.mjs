// Which tools the model may call, and how they are described to the Anthropic API.

/** Read-only MCP tools. None of them takes a file path. */
export const READ_TOOLS = [
  'model_info', 'schema_describe', 'query_entities', 'count_entities', 'get_entity', 'get_entities_bulk',
  'spatial_hierarchy', 'containment_chain', 'relationships', 'properties_unique', 'materials_list',
  'classifications_list', 'units', 'query_rooms', 'geometry_bbox', 'geometry_volume', 'geometry_area',
  'model_audit',
];

/** Editing MCP tools. Edits stay in the conversation's temporary model. */
export const WRITE_TOOLS = [
  'entity_set_property', 'entity_delete_property', 'entity_set_attribute', 'entity_create', 'entity_delete',
  'mutation_batch', 'mutation_diff', 'mutation_undo', 'place_opening', 'place_door', 'place_window',
  'edit_element_geometry', 'duplicate_element', 'copy_elements', 'array_elements', 'join_walls',
];

export const CUSTOM_TOOLS = {
  create_model: {
    name: 'create_model',
    description:
      'Create a brand-new IFC4 model (replacing the model currently open in this conversation, whose unsaved edits are lost) ' +
      'and make it the active model. Units are metres, Z is up. Each storey has an elevation and lists of walls (axis start/end), ' +
      'slabs (origin corner + width along X + depth along Y, extruded upwards by thickness) and columns (base position + width/depth/height). ' +
      'Coordinates inside a storey are relative to that storey elevation. The model exists only for this conversation.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        storeys: {
          type: 'array',
          description: 'Building storeys, bottom to top.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              elevation: { type: 'number', description: 'Storey elevation in metres (default 0).' },
              walls: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'array', items: { type: 'number' }, description: '[x, y] or [x, y, z] in metres.' },
                    end: { type: 'array', items: { type: 'number' }, description: '[x, y] or [x, y, z] in metres.' },
                    height: { type: 'number', description: 'Default 3.' },
                    thickness: { type: 'number', description: 'Default 0.2.' },
                    name: { type: 'string' },
                  },
                  required: ['start', 'end'],
                },
              },
              slabs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    origin: { type: 'array', items: { type: 'number' }, description: 'Corner [x, y] or [x, y, z].' },
                    width: { type: 'number', description: 'Size along X.' },
                    depth: { type: 'number', description: 'Size along Y.' },
                    thickness: { type: 'number', description: 'Default 0.2.' },
                    name: { type: 'string' },
                  },
                  required: ['origin', 'width', 'depth'],
                },
              },
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    position: { type: 'array', items: { type: 'number' }, description: 'Base point [x, y] or [x, y, z].' },
                    width: { type: 'number' },
                    depth: { type: 'number' },
                    height: { type: 'number' },
                    name: { type: 'string' },
                  },
                  required: ['position', 'width', 'depth', 'height'],
                },
              },
            },
          },
        },
      },
      required: ['name', 'storeys'],
    },
  },
};

/** Provider tool definitions from the MCP tool list, restricted to the allowlist. */
export function buildToolDefs(mcpTools, { readOnly }) {
  const allowed = new Set(readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]);
  const taking = new Set();
  const defs = [];
  for (const tool of mcpTools) {
    if (!allowed.has(tool.name)) continue;
    const schema = structuredClone(tool.inputSchema ?? { type: 'object', properties: {} });
    if (schema.properties?.model_id) {
      taking.add(tool.name);
      delete schema.properties.model_id; // a single model is ever loaded: always 'active'
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => key !== 'model_id');
    }
    defs.push({ name: tool.name, description: tool.description ?? '', input_schema: schema });
  }
  if (!readOnly) defs.push(CUSTOM_TOOLS.create_model);
  return { defs, activeModelTools: taking, allowed };
}
