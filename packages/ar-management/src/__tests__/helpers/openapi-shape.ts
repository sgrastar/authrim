import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * A small check of an answer against the schema the Admin API's OpenAPI documents: the parts of
 * JSON Schema the spec (OpenAPI 3.2, so a null is `type: 'null'`, never `nullable`) uses for
 * answers ($ref, oneOf, allOf, type, enum, required, properties, additionalProperties: false,
 * items). For contract tests that pin an answer to its documentation.
 */
export type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  oneOf?: Schema[];
  allOf?: Schema[];
};

/** The schemas of the Admin API's spec. */
export function adminOpenApiSchemas(): Record<string, Schema> {
  const spec = parseYaml(
    readFileSync(new URL('../../../openapi/admin.openapi.yaml', import.meta.url), 'utf8')
  ) as { components: { schemas: Record<string, Schema> } };
  return spec.components.schemas;
}

/**
 * Whether `value` has the shape `schema` documents: every required key, no key it does not list,
 * enums kept. Returns the paths that differ.
 */
export function shapeErrors(
  schemas: Record<string, Schema>,
  schema: Schema,
  value: unknown,
  path = '$'
): string[] {
  const errors: string[] = [];
  const resolved = schema.$ref ? (schemas[schema.$ref.split('/').pop() ?? ''] ?? {}) : schema;
  if (resolved.allOf) {
    return resolved.allOf.flatMap((part) => shapeErrors(schemas, part, value, path));
  }
  if (resolved.oneOf) {
    const matching = resolved.oneOf.filter(
      (variant) => shapeErrors(schemas, variant, value, path).length === 0
    );
    return matching.length === 1 ? [] : [`${path}: matches ${matching.length} variants`];
  }
  const typeOf = (item: unknown) =>
    item === null
      ? 'null'
      : Array.isArray(item)
        ? 'array'
        : Number.isInteger(item)
          ? 'integer'
          : typeof item;
  const types = [resolved.type ?? (resolved.properties ? 'object' : [])].flat();
  const actual = typeOf(value);
  if (
    types.length > 0 &&
    !types.includes(actual) &&
    !(actual === 'integer' && types.includes('number'))
  ) {
    return [`${path}: ${actual} is not ${types.join('|')}`];
  }
  if (resolved.enum && !resolved.enum.includes(value)) errors.push(`${path}: ${String(value)}`);
  if (resolved.properties && actual === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of resolved.required ?? []) if (!(key in record)) errors.push(`${path}.${key}`);
    for (const [key, child] of Object.entries(record)) {
      const childSchema = resolved.properties[key];
      if (!childSchema) {
        if (resolved.additionalProperties === false) errors.push(`${path}.${key} (undocumented)`);
        continue;
      }
      errors.push(...shapeErrors(schemas, childSchema, child, `${path}.${key}`));
    }
  }
  if (resolved.items && Array.isArray(value)) {
    value.forEach((item, index) =>
      errors.push(...shapeErrors(schemas, resolved.items!, item, `${path}[${index}]`))
    );
  }
  return errors;
}
