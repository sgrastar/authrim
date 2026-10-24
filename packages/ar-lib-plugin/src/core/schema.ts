/**
 * Schema Utilities
 *
 * Converts Zod schemas to JSON Schema for Admin UI form generation
 * and API documentation.
 */

import { z } from 'zod';
import {
  legacyZodErrorMessage,
  toLegacyZodIssues,
} from '@authrim/ar-lib-core/utils/zod-legacy-errors';
import type { AuthrimPlugin, PluginMeta } from './types';

// =============================================================================
// JSON Schema Types
// =============================================================================

/**
 * JSON Schema 7 compatible type
 */
export interface JSONSchema7 {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $comment?: string;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  type?: JSONSchema7TypeName | JSONSchema7TypeName[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema7;
  items?: JSONSchema7 | JSONSchema7[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  oneOf?: JSONSchema7[];
  anyOf?: JSONSchema7[];
  allOf?: JSONSchema7[];
  not?: JSONSchema7;
  definitions?: Record<string, JSONSchema7>;
  $defs?: Record<string, JSONSchema7>;
}

export type JSONSchema7TypeName =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

// =============================================================================
// Schema Conversion
// =============================================================================

/**
 * Convert a Zod schema to JSON Schema
 *
 * Produces the draft-07 document zod-to-json-schema produced for these schemas before
 * the zod 4 migration (input view: fields with defaults are optional), so the schemas
 * already stored in KV and rendered by the Admin UI keep their shape.
 *
 * @param schema - Zod schema to convert
 * @param options - Conversion options
 * @returns JSON Schema 7 compatible object
 */
export function zodToJSONSchema<T>(
  schema: z.ZodType<T, unknown>,
  options?: SchemaConversionOptions
): JSONSchema7 {
  const document = toLegacyJSONSchema(schema, options);

  if (!options?.name) {
    return document;
  }

  // zod-to-json-schema wrapped named schemas in a root definitions map. Generated
  // definitions (shared or recursive parts) stay at the root so their refs resolve.
  const { $schema, definitions, ...definition } = document;
  return {
    $ref: `#/definitions/${options.name}`,
    definitions: { ...definitions, [options.name]: definition },
    $schema,
  };
}

function toLegacyJSONSchema(
  schema: z.core.$ZodType,
  options?: SchemaConversionOptions
): JSONSchema7 {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    reused: options?.$refStrategy && options.$refStrategy !== 'none' ? 'ref' : 'inline',
    override: ({ zodSchema, jsonSchema }) => keepLegacyJSONSchemaShape(zodSchema, jsonSchema),
  }) as JSONSchema7;
}

const MAX_SAFE_INTEGER_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * Undo the places where zod 4's JSON Schema output differs from zod-to-json-schema's
 * for the same schema: strip objects keep `additionalProperties: false` in the input
 * view, loose objects keep `true`, records drop the implied string `propertyNames`,
 * built-in string formats do not repeat their regex as `pattern`, unions of literals
 * stay a typed `enum`, integers do not spell out the safe-integer range, and dates,
 * bigints and sets keep the types zod-to-json-schema gave them (zod 4 treats them as
 * unrepresentable and would emit `{}`).
 */
function keepLegacyJSONSchemaShape(
  zodSchema: z.core.$ZodType,
  jsonSchema: z.core.JSONSchema.BaseSchema
): void {
  const def = zodSchema._zod.def;

  if (def.type === 'object' && jsonSchema.type === 'object') {
    const catchall = (def as z.core.$ZodObjectDef).catchall;
    const catchallType = catchall?._zod.def.type;
    if (catchall === undefined || catchallType === 'never') {
      jsonSchema.additionalProperties = false;
    } else if (catchallType === 'unknown' || catchallType === 'any') {
      jsonSchema.additionalProperties = true;
    }
  }

  if (def.type === 'record') {
    const propertyNames = jsonSchema.propertyNames as Record<string, unknown> | undefined;
    if (
      propertyNames &&
      Object.keys(propertyNames).length === 1 &&
      propertyNames.type === 'string'
    ) {
      delete jsonSchema.propertyNames;
    }
  }

  if (typeof jsonSchema.pattern === 'string' && typeof jsonSchema.format === 'string') {
    if (builtinFormatPatterns(zodSchema).includes(jsonSchema.pattern)) {
      delete jsonSchema.pattern;
    }
  }

  if (def.type === 'union' && Array.isArray(jsonSchema.anyOf)) {
    const literals = literalUnionValues(def as z.core.$ZodUnionDef);
    if (literals) {
      delete jsonSchema.anyOf;
      jsonSchema.type = literals.type;
      jsonSchema.enum = literals.values;
    }
  }

  if (def.type === 'date') {
    jsonSchema.type = 'string';
    jsonSchema.format = 'date-time';
  } else if (def.type === 'bigint') {
    jsonSchema.type = 'integer';
    jsonSchema.format = 'int64';
  } else if (def.type === 'set') {
    const setDef = def as z.core.$ZodSetDef;
    const { $schema: _schema, ...items } = toLegacyJSONSchema(setDef.valueType);
    jsonSchema.type = 'array';
    jsonSchema.uniqueItems = true;
    jsonSchema.items = items as z.core.JSONSchema.BaseSchema;
    for (const check of setDef.checks ?? []) {
      const checkDef = check._zod.def as { check?: string; minimum?: number; maximum?: number };
      if (checkDef.check === 'min_size') jsonSchema.minItems = checkDef.minimum;
      if (checkDef.check === 'max_size') jsonSchema.maxItems = checkDef.maximum;
    }
  }

  if (jsonSchema.type === 'integer') {
    if (jsonSchema.minimum === -MAX_SAFE_INTEGER_BOUND) delete jsonSchema.minimum;
    if (jsonSchema.maximum === MAX_SAFE_INTEGER_BOUND) delete jsonSchema.maximum;
  }
}

/** `{ type, enum }` for a union of same-typed primitive literals (`z.literal(6).or(z.literal(8))`). */
function literalUnionValues(
  def: z.core.$ZodUnionDef
): { type: 'string' | 'number' | 'boolean'; values: Array<string | number | boolean> } | undefined {
  const values: Array<string | number | boolean> = [];
  for (const option of def.options) {
    const optionDef = option._zod.def;
    if (optionDef.type !== 'literal') return undefined;
    for (const value of (optionDef as z.core.$ZodLiteralDef<z.core.util.Literal>).values) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return undefined;
      }
      values.push(value);
    }
  }
  const types = new Set(values.map((value) => typeof value));
  const [type] = [...types];
  if (types.size !== 1 || (type !== 'string' && type !== 'number' && type !== 'boolean')) {
    return undefined;
  }
  return { type, values };
}

/** Regex sources of the built-in string formats (email, uuid, ...) on a schema. */
function builtinFormatPatterns(zodSchema: z.core.$ZodType): string[] {
  const def = zodSchema._zod.def as z.core.$ZodTypeDef & {
    checks?: z.core.$ZodCheck[];
  };
  const candidates: unknown[] = [zodSchema, ...(def.checks ?? [])];
  const patterns: string[] = [];
  for (const candidate of candidates) {
    const candidateDef = (candidate as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (
      candidateDef?.format !== undefined &&
      candidateDef.format !== 'regex' &&
      candidateDef.pattern instanceof RegExp
    ) {
      patterns.push(candidateDef.pattern.source);
    }
  }
  return patterns;
}

/**
 * Options for schema conversion
 */
export interface SchemaConversionOptions {
  /** Schema name (used for $id) */
  name?: string;

  /** Custom $ref strategy */
  $refStrategy?: 'none' | 'root' | 'relative';
}

// =============================================================================
// Plugin Schema Utilities
// =============================================================================

/**
 * Plugin schema information for Admin UI
 */
export interface PluginSchemaInfo {
  /** Plugin ID */
  pluginId: string;

  /** Plugin version */
  version: string;

  /** Plugin metadata */
  meta?: PluginMeta;

  /** Configuration JSON Schema */
  configSchema: JSONSchema7;

  /** Whether this is an official plugin */
  official?: boolean;

  /** Capabilities provided */
  capabilities: string[];
}

/**
 * Extract schema information from a plugin
 *
 * @param plugin - Authrim plugin
 * @returns Schema information for Admin UI
 */
export function extractPluginSchema<T>(plugin: AuthrimPlugin<T>): PluginSchemaInfo {
  const configSchema = zodToJSONSchema(plugin.configSchema, {
    name: `${plugin.id}-config`,
  });

  // Add plugin metadata to schema
  configSchema.title = plugin.meta?.name ?? plugin.id;
  configSchema.description = plugin.meta?.description;

  return {
    pluginId: plugin.id,
    version: plugin.version,
    meta: plugin.meta,
    configSchema,
    official: plugin.official,
    capabilities: plugin.capabilities,
  };
}

/**
 * Validate configuration against a Zod schema
 *
 * @param schema - Zod schema to validate against
 * @param config - Configuration to validate
 * @returns Validation result
 */
export function validatePluginConfig<T>(
  schema: z.ZodType<T, unknown>,
  config: unknown
): ValidationResult<T> {
  // zod 3 messages and codes: plugin-config errors are part of the Admin API surface.
  const result = schema.safeParse(config, { error: legacyZodErrorMessage, reportInput: true });

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    errors: toLegacyZodIssues(result.error.issues).map((e) => ({
      path: e.path.map(String).join('.'),
      message: e.message,
      code: e.code,
    })),
  };
}

/**
 * Validate configuration against a plugin's schema
 *
 * @param plugin - Authrim plugin
 * @param config - Configuration to validate
 * @returns Validation result
 */
export function validatePluginConfigFromPlugin<T>(
  plugin: AuthrimPlugin<T>,
  config: unknown
): ValidationResult<T> {
  return validatePluginConfig(plugin.configSchema, config);
}

/**
 * Validation result
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationError[] };

/**
 * Validation error
 */
export interface ValidationError {
  /** Path to the invalid field */
  path: string;

  /** Error message */
  message: string;

  /** Zod error code (zod 3 vocabulary, e.g. `invalid_string`) */
  code: string;
}

// =============================================================================
// Schema Registry
// =============================================================================

/**
 * Registry for plugin schemas
 *
 * Used by Admin UI to generate configuration forms.
 */
export class PluginSchemaRegistry {
  private schemas = new Map<string, PluginSchemaInfo>();

  /**
   * Register a plugin's schema
   */
  register<T>(plugin: AuthrimPlugin<T>): void {
    const schemaInfo = extractPluginSchema(plugin);
    this.schemas.set(plugin.id, schemaInfo);
  }

  /**
   * Get a plugin's schema
   */
  get(pluginId: string): PluginSchemaInfo | undefined {
    return this.schemas.get(pluginId);
  }

  /**
   * Get all registered schemas
   */
  getAll(): PluginSchemaInfo[] {
    return Array.from(this.schemas.values());
  }

  /**
   * Get schemas by category
   */
  getByCategory(category: string): PluginSchemaInfo[] {
    return Array.from(this.schemas.values()).filter((s) => s.meta?.category === category);
  }

  /**
   * Check if a plugin is registered
   */
  has(pluginId: string): boolean {
    return this.schemas.has(pluginId);
  }

  /**
   * Remove a plugin's schema
   */
  unregister(pluginId: string): boolean {
    return this.schemas.delete(pluginId);
  }

  /**
   * Clear all schemas
   */
  clear(): void {
    this.schemas.clear();
  }
}

/**
 * Global schema registry instance
 */
export const globalSchemaRegistry = new PluginSchemaRegistry();

// =============================================================================
// Form Field Hints
// =============================================================================

/**
 * Extract form field hints from a JSON Schema
 *
 * Useful for Admin UI to determine appropriate input types.
 */
export function extractFormFieldHints(schema: JSONSchema7): FormFieldHint[] {
  const hints: FormFieldHint[] = [];

  if (schema.type !== 'object' || !schema.properties) {
    return hints;
  }

  const required = new Set(schema.required ?? []);

  for (const [name, propSchema] of Object.entries(schema.properties)) {
    const prop = propSchema as JSONSchema7;
    hints.push({
      name,
      type: determineFieldType(prop),
      required: required.has(name),
      label: prop.title ?? name,
      description: prop.description,
      default: prop.default,
      placeholder: determinePlaceholder(prop),
      validation: extractValidation(prop),
    });
  }

  return hints;
}

/**
 * Form field hint for UI generation
 */
export interface FormFieldHint {
  name: string;
  type: FormFieldType;
  required: boolean;
  label?: string;
  description?: string;
  default?: unknown;
  placeholder?: string;
  validation?: FormFieldValidation;
}

export type FormFieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'url'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'textarea'
  | 'json';

export interface FormFieldValidation {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  options?: unknown[];
}

function determineFieldType(schema: JSONSchema7): FormFieldType {
  // Check for enum first
  if (schema.enum) {
    return 'select';
  }

  // Check format
  if (schema.format) {
    switch (schema.format) {
      case 'email':
        return 'email';
      case 'uri':
      case 'url':
        return 'url';
      case 'password':
        return 'password';
    }
  }

  // Check type
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string':
      // Long text
      if (schema.maxLength && schema.maxLength > 200) {
        return 'textarea';
      }
      return 'text';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'json';
    case 'array':
      if (schema.items && (schema.items as JSONSchema7).enum) {
        return 'multiselect';
      }
      return 'json';
    default:
      return 'text';
  }
}

function determinePlaceholder(schema: JSONSchema7): string | undefined {
  if (schema.examples && schema.examples.length > 0) {
    const example = schema.examples[0];
    if (typeof example === 'object' && example !== null) {
      return JSON.stringify(example);
    }
    return String(example as string | number | boolean);
  }
  if (schema.default !== undefined) {
    const defaultVal = schema.default;
    if (typeof defaultVal === 'object' && defaultVal !== null) {
      return JSON.stringify(defaultVal);
    }
    return String(defaultVal as string | number | boolean);
  }
  return undefined;
}

function extractValidation(schema: JSONSchema7): FormFieldValidation | undefined {
  const validation: FormFieldValidation = {};
  let hasValidation = false;

  if (schema.minLength !== undefined) {
    validation.minLength = schema.minLength;
    hasValidation = true;
  }
  if (schema.maxLength !== undefined) {
    validation.maxLength = schema.maxLength;
    hasValidation = true;
  }
  if (schema.minimum !== undefined) {
    validation.minimum = schema.minimum;
    hasValidation = true;
  }
  if (schema.maximum !== undefined) {
    validation.maximum = schema.maximum;
    hasValidation = true;
  }
  if (schema.pattern !== undefined) {
    validation.pattern = schema.pattern;
    hasValidation = true;
  }
  if (schema.enum !== undefined) {
    validation.options = schema.enum;
    hasValidation = true;
  }

  return hasValidation ? validation : undefined;
}
