// Builds an IFC4 file from a validated, LLM-friendly description.
import { IfcCreator } from '@ifc-lite/create';

const MAX_STOREYS = 30;
const MAX_ELEMENTS = 500;
const MAX_COORD = 10_000;

/** STEP files are ASCII-only: escape other characters as \X2\hhhh\X0\ (or \X4\ beyond the BMP). */
export function toStepAscii(text) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code <= 0x7f) out += char;
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }
  return out;
}

function num(label, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function point(label, value, { allowZ = true } = {}) {
  if (!Array.isArray(value) || value.length < 2 || value.length > (allowZ ? 3 : 2)) {
    throw new Error(`${label} must be [x, y${allowZ ? ', z' : ''}] in metres.`);
  }
  const [x, y, z = 0] = value;
  return [num(`${label}.x`, x, -MAX_COORD, MAX_COORD), num(`${label}.y`, y, -MAX_COORD, MAX_COORD), num(`${label}.z`, z, -MAX_COORD, MAX_COORD)];
}

function optionalName(value) {
  return typeof value === 'string' && value.trim() ? { Name: value.trim().slice(0, 120) } : {};
}

/**
 * @param {{ name: string, storeys: Array<{ name?: string, elevation?: number,
 *   walls?: Array<{ start: number[], end: number[], height?: number, thickness?: number, name?: string }>,
 *   slabs?: Array<{ origin: number[], width: number, depth: number, thickness?: number, name?: string }>,
 *   columns?: Array<{ position: number[], width: number, depth: number, height: number, name?: string }> }> }} spec
 * @returns {{ content: string, counts: { storeys: number, walls: number, slabs: number, columns: number } }}
 */
export function buildModel(spec) {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new Error('name is required.');
  if (!Array.isArray(spec.storeys) || spec.storeys.length < 1 || spec.storeys.length > MAX_STOREYS) {
    throw new Error(`storeys must be an array of 1 to ${MAX_STOREYS} storeys.`);
  }

  const counts = { storeys: 0, walls: 0, slabs: 0, columns: 0 };
  const total = () => counts.walls + counts.slabs + counts.columns;
  const creator = new IfcCreator({ Name: spec.name.trim().slice(0, 120) });

  spec.storeys.forEach((storeySpec, index) => {
    const elevation = storeySpec.elevation === undefined ? 0 : num('storey.elevation', storeySpec.elevation, -100, 1000);
    const storey = creator.addIfcBuildingStorey({
      Name: typeof storeySpec.name === 'string' && storeySpec.name.trim() ? storeySpec.name.trim().slice(0, 120) : `Level ${index}`,
      Elevation: elevation,
    });
    counts.storeys += 1;

    for (const wall of storeySpec.walls ?? []) {
      if (total() >= MAX_ELEMENTS) throw new Error(`Too many elements (max ${MAX_ELEMENTS}).`);
      const start = point('wall.start', wall.start);
      const end = point('wall.end', wall.end);
      if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) throw new Error('A wall cannot have identical start and end points.');
      creator.addIfcWall(storey, {
        Start: start,
        End: end,
        Thickness: wall.thickness === undefined ? 0.2 : num('wall.thickness', wall.thickness, 0.05, 2),
        Height: wall.height === undefined ? 3 : num('wall.height', wall.height, 0.3, 50),
        ...optionalName(wall.name),
      });
      counts.walls += 1;
    }
    for (const slab of storeySpec.slabs ?? []) {
      if (total() >= MAX_ELEMENTS) throw new Error(`Too many elements (max ${MAX_ELEMENTS}).`);
      creator.addIfcSlab(storey, {
        Position: point('slab.origin', slab.origin),
        Width: num('slab.width', slab.width, 0.1, 1000),
        Depth: num('slab.depth', slab.depth, 0.1, 1000),
        Thickness: slab.thickness === undefined ? 0.2 : num('slab.thickness', slab.thickness, 0.05, 5),
        ...optionalName(slab.name),
      });
      counts.slabs += 1;
    }
    for (const column of storeySpec.columns ?? []) {
      if (total() >= MAX_ELEMENTS) throw new Error(`Too many elements (max ${MAX_ELEMENTS}).`);
      creator.addIfcColumn(storey, {
        Position: point('column.position', column.position),
        Width: num('column.width', column.width, 0.05, 5),
        Depth: num('column.depth', column.depth, 0.05, 5),
        Height: num('column.height', column.height, 0.3, 50),
        ...optionalName(column.name),
      });
      counts.columns += 1;
    }
  });

  if (total() === 0) throw new Error('The model has no elements: add walls, slabs or columns.');
  return { content: toStepAscii(creator.toIfc().content), counts };
}
