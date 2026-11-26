// Небольшой валидатор JSON Schema (подмножество 2020-12), достаточный для схем инструментов и проверки outputSchema
// в тестах без внешних зависимостей: type, enum, const, pattern, границы, required, properties, additionalProperties,
// items, uniqueItems, oneOf, anyOf, локальный $ref на $defs корня. Неизвестные ключевые слова игнорируются.

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let node = root;
  for (const part of ref.slice(2).split('/')) { node = node?.[part]; if (node === undefined) return undefined; }
  return node;
}

const patterns = new Map();
function regex(pattern) {
  let value = patterns.get(pattern);
  if (!value) { value = new RegExp(pattern); patterns.set(pattern, value); }
  return value;
}

/** Возвращает undefined, если значение подходит, иначе короткое описание первого нарушения: «путь: правило». */
export function firstError(schema, value, root = schema, at = '$') {
  if (schema === true || schema === undefined) return undefined;
  if (schema === false) return `${at}: not allowed`;
  if (schema.$ref !== undefined) {
    const target = resolveRef(root, schema.$ref);
    if (target === undefined) return `${at}: unresolved reference`;
    return firstError(target, value, root, at);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => firstError(option, value, root, at) === undefined).length;
    if (matches !== 1) return `${at}: must match exactly one allowed form`;
  }
  if (schema.anyOf && !schema.anyOf.some(option => firstError(option, value, root, at) === undefined)) return `${at}: must match an allowed form`;
  if (schema.const !== undefined && value !== schema.const) return `${at}: must equal ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at}: must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`;
  switch (schema.type) {
    case undefined: break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at}: must be an object`;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${at}.${key}: required`;
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          const problem = firstError(properties[key], item, root, `${at}.${key}`);
          if (problem) return problem;
        } else if (schema.additionalProperties === false) return `${at}.${key}: not allowed`;
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          const problem = firstError(schema.additionalProperties, item, root, `${at}.${key}`);
          if (problem) return problem;
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at}: must be an array`;
      if (value.length < (schema.minItems ?? 0)) return `${at}: needs at least ${schema.minItems} items`;
      if (value.length > (schema.maxItems ?? Infinity)) return `${at}: allows at most ${schema.maxItems} items`;
      if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return `${at}: items must be unique`;
      if (schema.items) for (let index = 0; index < value.length; index++) { const problem = firstError(schema.items, value[index], root, `${at}[${index}]`); if (problem) return problem; }
      break;
    }
    case 'integer':
      if (!Number.isSafeInteger(value)) return `${at}: must be an integer`;
      // fallthrough
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at}: must be a number`;
      if (value < (schema.minimum ?? -Infinity)) return `${at}: must be at least ${schema.minimum}`;
      if (value > (schema.maximum ?? Infinity)) return `${at}: must be at most ${schema.maximum}`;
      break;
    case 'boolean': if (typeof value !== 'boolean') return `${at}: must be a boolean`; break;
    case 'null': if (value !== null) return `${at}: must be null`; break;
    case 'string':
      if (typeof value !== 'string') return `${at}: must be a string`;
      if (value.length < (schema.minLength ?? 0)) return `${at}: is too short`;
      if (value.length > (schema.maxLength ?? Infinity)) return `${at}: is too long`;
      if (schema.pattern && !regex(schema.pattern).test(value)) return `${at}: has an invalid format`;
      break;
    default: return `${at}: unsupported schema type`;
  }
  return undefined;
}

export const validates = (schema, value) => firstError(schema, value) === undefined;
