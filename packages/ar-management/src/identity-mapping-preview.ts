import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  previewCsvDryRun,
  previewDestinationRelease,
} from '@authrim/ar-lib-identity-mapping/experimental';
import type {
  CsvDryRunPreviewInput,
  CsvDryRunPreviewResult,
  DestinationPreviewProtocol,
  DestinationReleasePreviewInput,
  DestinationReleasePreviewResult,
} from '@authrim/ar-lib-identity-mapping/experimental';

type AdminContext = Context<{ Bindings: Env }>;

const MAX_CSV_PREVIEW_ROWS = 100;
const MAX_CSV_PREVIEW_ROW_FIELDS = 200;
const MAX_CSV_PREVIEW_EDGES = 500;
const MAX_CSV_PREVIEW_TRANSFORMS = 500;
const MAX_CSV_PREVIEW_VALIDATION_RULES = 250;
const MAX_CSV_PREVIEW_REQUIRED_COLUMNS = 250;
const MAX_DESTINATION_PREVIEW_VALUES = 250;
const MAX_DESTINATION_REQUESTED_ATTRIBUTES = 250;
const MAX_PREVIEW_JSON_BYTES = 128 * 1024;
const MAX_PREVIEW_JSON_DEPTH = 12;
const MAX_PREVIEW_JSON_NODES = 4000;
const MAX_PREVIEW_JSON_ARRAY_ITEMS = 1000;
const MAX_PREVIEW_JSON_OBJECT_KEYS = 500;
const MAX_PREVIEW_JSON_STRING_CHARS = 4096;

export interface AdminCsvDryRunPreviewResponse extends CsvDryRunPreviewResult {
  preview: {
    protocol: 'csv';
    persisted: false;
    maxRows: number;
  };
}

export interface AdminDestinationReleasePreviewResponse extends DestinationReleasePreviewResult {
  preview: {
    protocol: DestinationPreviewProtocol;
    persisted: false;
  };
}

export async function adminCsvDryRunPreviewHandler(c: AdminContext): Promise<Response | void> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalidRequest(c, 'Request body must be valid JSON');
  }

  const validationError = validateCsvDryRunPreviewRequest(body);
  if (validationError) {
    return invalidRequest(c, validationError);
  }

  const request = body as CsvDryRunPreviewInput;
  const result = previewCsvDryRun({
    rows: request.rows,
    columnToPath: request.columnToPath,
    catalog: request.catalog,
    edges: request.edges,
    transforms: request.transforms,
    validationRules: request.validationRules,
    requiredColumns: request.requiredColumns,
    maxRows: MAX_CSV_PREVIEW_ROWS,
  });

  return c.json<AdminCsvDryRunPreviewResponse>({
    preview: {
      protocol: 'csv',
      persisted: false,
      maxRows: MAX_CSV_PREVIEW_ROWS,
    },
    ...result,
  });
}

export async function adminSamlReleasePreviewHandler(c: AdminContext): Promise<Response | void> {
  return adminDestinationReleasePreviewHandler(c, 'saml');
}

export async function adminOidcReleasePreviewHandler(c: AdminContext): Promise<Response | void> {
  return adminDestinationReleasePreviewHandler(c, 'oidc');
}

async function adminDestinationReleasePreviewHandler(
  c: AdminContext,
  protocol: DestinationPreviewProtocol
): Promise<Response | void> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalidRequest(c, 'Request body must be valid JSON');
  }

  const validationError = validateDestinationReleasePreviewRequest(body, protocol);
  if (validationError) {
    return invalidRequest(c, validationError);
  }

  const request = body as DestinationReleasePreviewInput;
  const result = previewDestinationRelease({
    ...request,
    destination: {
      ...request.destination,
      protocol,
    },
  });

  return c.json<AdminDestinationReleasePreviewResponse>({
    preview: {
      protocol,
      persisted: false,
    },
    ...result,
  });
}

function validateCsvDryRunPreviewRequest(body: unknown): string | null {
  if (!isRecord(body)) {
    return 'Request body must be an object';
  }
  if (!Array.isArray(body.rows)) {
    return 'rows must be an array';
  }
  if (body.rows.length > MAX_CSV_PREVIEW_ROWS) {
    return `rows must contain at most ${MAX_CSV_PREVIEW_ROWS} items`;
  }
  if (!body.rows.every(isRecord)) {
    return 'each row must be an object';
  }
  const oversizedRow = body.rows.findIndex(
    (row) => Object.keys(row).length > MAX_CSV_PREVIEW_ROW_FIELDS
  );
  if (oversizedRow >= 0) {
    return `rows[${oversizedRow}] must contain at most ${MAX_CSV_PREVIEW_ROW_FIELDS} fields`;
  }
  if (!isStringRecord(body.columnToPath)) {
    return 'columnToPath must be an object of string values';
  }
  if (!isRecord(body.catalog)) {
    return 'catalog is required';
  }
  if (!Array.isArray(body.edges)) {
    return 'edges must be an array';
  }
  if (body.edges.length > MAX_CSV_PREVIEW_EDGES) {
    return `edges must contain at most ${MAX_CSV_PREVIEW_EDGES} items`;
  }
  if (body.requiredColumns !== undefined && !isStringArray(body.requiredColumns)) {
    return 'requiredColumns must be an array of strings';
  }
  if (
    Array.isArray(body.requiredColumns) &&
    body.requiredColumns.length > MAX_CSV_PREVIEW_REQUIRED_COLUMNS
  ) {
    return `requiredColumns must contain at most ${MAX_CSV_PREVIEW_REQUIRED_COLUMNS} items`;
  }
  if (body.transforms !== undefined && !Array.isArray(body.transforms)) {
    return 'transforms must be an array';
  }
  if (Array.isArray(body.transforms) && body.transforms.length > MAX_CSV_PREVIEW_TRANSFORMS) {
    return `transforms must contain at most ${MAX_CSV_PREVIEW_TRANSFORMS} items`;
  }
  if (body.validationRules !== undefined && !Array.isArray(body.validationRules)) {
    return 'validationRules must be an array';
  }
  if (
    Array.isArray(body.validationRules) &&
    body.validationRules.length > MAX_CSV_PREVIEW_VALIDATION_RULES
  ) {
    return `validationRules must contain at most ${MAX_CSV_PREVIEW_VALIDATION_RULES} items`;
  }
  const budgetError = validateJsonBudget(body, 'request');
  if (budgetError) {
    return budgetError;
  }
  return null;
}

function validateDestinationReleasePreviewRequest(
  body: unknown,
  protocol: DestinationPreviewProtocol
): string | null {
  if (!isRecord(body)) {
    return 'Request body must be an object';
  }
  if (!isRecord(body.destination)) {
    return 'destination is required';
  }
  if (body.destination.protocol !== undefined && body.destination.protocol !== protocol) {
    return `destination.protocol must be ${protocol}`;
  }
  if (typeof body.destination.destinationId !== 'string') {
    return 'destination.destinationId is required';
  }
  if (typeof body.destination.purpose !== 'string') {
    return 'destination.purpose is required';
  }
  if (!Array.isArray(body.values)) {
    return 'values must be an array';
  }
  if (body.values.length > MAX_DESTINATION_PREVIEW_VALUES) {
    return `values must contain at most ${MAX_DESTINATION_PREVIEW_VALUES} items`;
  }
  if (!body.values.every(isRecord)) {
    return 'each value must be an object';
  }
  if (
    body.oidcClaimsRequest !== undefined &&
    (protocol !== 'oidc' || !isRecord(body.oidcClaimsRequest))
  ) {
    return 'oidcClaimsRequest is only valid for OIDC previews and must be an object';
  }
  if (
    body.samlRequestedAttributes !== undefined &&
    (protocol !== 'saml' || !Array.isArray(body.samlRequestedAttributes))
  ) {
    return 'samlRequestedAttributes is only valid for SAML previews and must be an array';
  }
  if (
    Array.isArray(body.samlRequestedAttributes) &&
    body.samlRequestedAttributes.length > MAX_DESTINATION_REQUESTED_ATTRIBUTES
  ) {
    return `samlRequestedAttributes must contain at most ${MAX_DESTINATION_REQUESTED_ATTRIBUTES} items`;
  }
  const budgetError = validateJsonBudget(body, 'request');
  if (budgetError) {
    return budgetError;
  }
  return null;
}

function validateJsonBudget(value: unknown, path: string): string | null {
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const visit = (item: unknown, currentPath: string, depth: number): string | null => {
    nodeCount += 1;
    if (nodeCount > MAX_PREVIEW_JSON_NODES) {
      return `${path} must contain at most ${MAX_PREVIEW_JSON_NODES} JSON nodes`;
    }
    if (depth > MAX_PREVIEW_JSON_DEPTH) {
      return `${currentPath} exceeds maximum depth ${MAX_PREVIEW_JSON_DEPTH}`;
    }
    if (typeof item === 'string' && item.length > MAX_PREVIEW_JSON_STRING_CHARS) {
      return `${currentPath} string value must be at most ${MAX_PREVIEW_JSON_STRING_CHARS} characters`;
    }
    if (item === undefined || item === null || typeof item !== 'object') {
      return null;
    }
    if (seen.has(item)) {
      return `${currentPath} must not contain circular references`;
    }
    seen.add(item);

    if (Array.isArray(item)) {
      if (item.length > MAX_PREVIEW_JSON_ARRAY_ITEMS) {
        return `${currentPath} array must contain at most ${MAX_PREVIEW_JSON_ARRAY_ITEMS} items`;
      }
      for (const [index, child] of item.entries()) {
        const error = visit(child, `${currentPath}[${index}]`, depth + 1);
        if (error) {
          return error;
        }
      }
      return null;
    }

    const entries = Object.entries(item);
    if (entries.length > MAX_PREVIEW_JSON_OBJECT_KEYS) {
      return `${currentPath} object must contain at most ${MAX_PREVIEW_JSON_OBJECT_KEYS} keys`;
    }
    for (const [key, child] of entries) {
      const error = visit(child, `${currentPath}.${key}`, depth + 1);
      if (error) {
        return error;
      }
    }
    return null;
  };

  const error = visit(value, path, 0);
  if (error) {
    return error;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_PREVIEW_JSON_BYTES) {
    return `${path} JSON must be at most ${MAX_PREVIEW_JSON_BYTES} bytes`;
  }
  return null;
}

function invalidRequest(c: AdminContext, errorDescription: string): Response {
  return c.json(
    {
      error: 'invalid_request',
      error_description: errorDescription,
    },
    400
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string' && item.length > 0)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
