import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { previewCsvDryRun } from '@authrim/ar-lib-identity-mapping/experimental';
import type {
  CsvDryRunPreviewInput,
  CsvDryRunPreviewResult,
} from '@authrim/ar-lib-identity-mapping/experimental';

type AdminContext = Context<{ Bindings: Env }>;

const MAX_CSV_PREVIEW_ROWS = 100;

export interface AdminCsvDryRunPreviewResponse extends CsvDryRunPreviewResult {
  preview: {
    protocol: 'csv';
    persisted: false;
    maxRows: number;
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
  if (!isStringRecord(body.columnToPath)) {
    return 'columnToPath must be an object of string values';
  }
  if (!isRecord(body.catalog)) {
    return 'catalog is required';
  }
  if (!Array.isArray(body.edges)) {
    return 'edges must be an array';
  }
  if (body.requiredColumns !== undefined && !isStringArray(body.requiredColumns)) {
    return 'requiredColumns must be an array of strings';
  }
  if (body.transforms !== undefined && !Array.isArray(body.transforms)) {
    return 'transforms must be an array';
  }
  if (body.validationRules !== undefined && !Array.isArray(body.validationRules)) {
    return 'validationRules must be an array';
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
