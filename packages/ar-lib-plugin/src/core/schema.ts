/**
 * Schema Utilities
 *
 * Converts Zod schemas to JSON Schema for Admin UI form generation
 * and API documentation.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
 * @param schema - Zod schema to convert
 * @param options - Conversion options
 * @returns JSON Schema 7 compatible object
 */
export function zodToJSONSchema<T>(
  schema: z.ZodSchema<T>,
  options?: SchemaConversionOptions
): JSONSchema7 {
  const result = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
    ...options,
  }) as JSONSchema7;

  return result;
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
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  config: unknown
): ValidationResult<T> {
  const result = schema.safeParse(config);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    errors: result.error.errors.map((e) => ({
      path: e.path.join('.'),
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

  /** Zod error code */
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
