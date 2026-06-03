import { shortHash } from '../core/ids';
import type { RedactionClassification } from '../core/types';

export type CsvSourceProfileValueType =
  | 'string'
  | 'email'
  | 'phone'
  | 'number'
  | 'boolean'
  | 'json'
  | 'date'
  | 'datetime';

export type CsvSourceProfileWarningCode =
  | 'pii_candidate'
  | 'regulated_candidate'
  | 'required_candidate'
  | 'type_candidate'
  | 'duplicate_header'
  | 'empty_header'
  | 'column_limit_reached'
  | 'row_sample_limit_reached';

export interface CsvSourceProfileParserOptions {
  delimiter?: 'auto' | ',' | '\t' | ';' | '|';
  quote?: '"' | "'";
  escape?: '"' | "'" | '\\';
  newline?: 'auto' | '\n' | '\r\n';
  headerMode?: 'auto' | 'first_row' | 'none';
  maxRows?: number;
  maxColumns?: number;
}

export interface CsvSourceProfileWarning {
  code: CsvSourceProfileWarningCode;
  severity: 'info' | 'warning' | 'error';
  columnId?: string;
  message: string;
}

export interface CsvSourceProfileColumn {
  stableColumnId: string;
  headerName: string;
  label: string;
  valueType: CsvSourceProfileValueType;
  required: boolean;
  classification: RedactionClassification;
  candidates: {
    valueType?: CsvSourceProfileValueType;
    required?: boolean;
    classification?: RedactionClassification;
  };
  warnings: CsvSourceProfileWarningCode[];
  emptyRate: number;
  observedNonEmptyRows: number;
}

export interface CsvSourceProfileParseResult {
  sourceType: 'csv';
  parser: {
    delimiter: ',' | '\t' | ';' | '|';
    quote: '"' | "'";
    escape: '"' | "'" | '\\';
    newline: '\n' | '\r\n';
    headerMode: 'first_row' | 'none';
    sampledRows: number;
    sampledColumns: number;
    truncatedRows: boolean;
    truncatedColumns: boolean;
  };
  columns: CsvSourceProfileColumn[];
  warnings: CsvSourceProfileWarning[];
  summary: {
    columnCount: number;
    rowSampleCount: number;
    piiCandidateCount: number;
    regulatedCandidateCount: number;
    requiredCandidateCount: number;
    blockingWarningCount: number;
  };
}

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_COLUMNS = 200;
const MAX_PARSE_CHARACTERS = 1_000_000;

const PII_NAME_PATTERNS = [
  /(^|[_\-\s.])e-?mail($|[_\-\s.])/i,
  /(^|[_\-\s.])mail($|[_\-\s.])/i,
  /phone|mobile|tel/i,
  /first[_\-\s.]*name|last[_\-\s.]*name|family[_\-\s.]*name|given[_\-\s.]*name/i,
  /display[_\-\s.]*name|full[_\-\s.]*name/i,
  /address|street|city|postal|zip/i,
  /birth|dob/i,
];

const REGULATED_NAME_PATTERNS = [
  /my[_\-\s.]*number|personal[_\-\s.]*number/i,
  /ssn|tax[_\-\s.]*id|national[_\-\s.]*id/i,
  /passport|driver[_\-\s.]*license/i,
];

export function parseCsvSourceProfile(
  input: string,
  options: CsvSourceProfileParserOptions = {}
): CsvSourceProfileParseResult {
  const boundedInput =
    input.length > MAX_PARSE_CHARACTERS ? input.slice(0, MAX_PARSE_CHARACTERS) : input;
  const delimiter = detectDelimiter(boundedInput, options.delimiter ?? 'auto');
  const newline = detectNewline(boundedInput, options.newline ?? 'auto');
  const quote = options.quote ?? '"';
  const escape = options.escape ?? quote;
  const maxRows = normalizeLimit(options.maxRows, DEFAULT_MAX_ROWS);
  const maxColumns = normalizeLimit(options.maxColumns, DEFAULT_MAX_COLUMNS);
  const parsed = parseRows(boundedInput, {
    delimiter,
    quote,
    escape,
    maxRows: maxRows + 1,
  });
  const headerMode = resolveHeaderMode(parsed.rows, options.headerMode ?? 'auto');
  const headerRow = headerMode === 'first_row' ? (parsed.rows[0] ?? []) : [];
  const dataRows = headerMode === 'first_row' ? parsed.rows.slice(1) : parsed.rows;
  const columnCount = Math.min(maxColumns, Math.max(...parsed.rows.map((row) => row.length), 0));
  const truncatedColumns = parsed.rows.some((row) => row.length > maxColumns);
  const warnings: CsvSourceProfileWarning[] = [];
  const seenHeaders = new Map<string, number>();
  const columns: CsvSourceProfileColumn[] = [];

  for (let index = 0; index < columnCount; index += 1) {
    const rawHeader = headerMode === 'first_row' ? (headerRow[index] ?? '') : '';
    const fallbackHeader = `column_${index + 1}`;
    const headerName = rawHeader.trim() || fallbackHeader;
    const normalizedHeader = headerName.toLowerCase();
    seenHeaders.set(normalizedHeader, (seenHeaders.get(normalizedHeader) ?? 0) + 1);
    const values = dataRows.map((row) => row[index] ?? '');
    const stats = inferColumn(values, headerName);
    const stableColumnId = createStableColumnId(headerName, index);
    const columnWarnings: CsvSourceProfileWarningCode[] = [];

    if (!rawHeader.trim() && headerMode === 'first_row') {
      columnWarnings.push('empty_header');
      warnings.push({
        code: 'empty_header',
        severity: 'warning',
        columnId: stableColumnId,
        message: `${fallbackHeader} has an empty header name.`,
      });
    }
    if ((seenHeaders.get(normalizedHeader) ?? 0) > 1) {
      columnWarnings.push('duplicate_header');
      warnings.push({
        code: 'duplicate_header',
        severity: 'warning',
        columnId: stableColumnId,
        message: `${headerName} appears more than once.`,
      });
    }
    if (stats.classificationCandidate === 'pii') {
      columnWarnings.push('pii_candidate');
      warnings.push({
        code: 'pii_candidate',
        severity: 'warning',
        columnId: stableColumnId,
        message: `${headerName} looks like PII and must be confirmed before activation.`,
      });
    }
    if (stats.classificationCandidate === 'regulated') {
      columnWarnings.push('regulated_candidate');
      warnings.push({
        code: 'regulated_candidate',
        severity: 'warning',
        columnId: stableColumnId,
        message: `${headerName} looks regulated and must be confirmed before activation.`,
      });
    }
    if (stats.requiredCandidate) {
      columnWarnings.push('required_candidate');
      warnings.push({
        code: 'required_candidate',
        severity: 'info',
        columnId: stableColumnId,
        message: `${headerName} has no empty sampled values and is a required candidate.`,
      });
    }
    if (stats.valueType !== 'string') {
      columnWarnings.push('type_candidate');
    }

    columns.push({
      stableColumnId,
      headerName,
      label: labelFromHeader(headerName),
      valueType: stats.valueType,
      required: false,
      classification: 'internal',
      candidates: {
        valueType: stats.valueType === 'string' ? undefined : stats.valueType,
        required: stats.requiredCandidate || undefined,
        classification: stats.classificationCandidate,
      },
      warnings: columnWarnings,
      emptyRate: stats.emptyRate,
      observedNonEmptyRows: stats.nonEmptyValues.length,
    });
  }

  if (truncatedColumns) {
    warnings.push({
      code: 'column_limit_reached',
      severity: 'warning',
      message: `Only the first ${maxColumns} columns were sampled.`,
    });
  }
  if (parsed.truncated || input.length > MAX_PARSE_CHARACTERS) {
    warnings.push({
      code: 'row_sample_limit_reached',
      severity: 'info',
      message: `Only the first ${maxRows} data rows were sampled.`,
    });
  }

  const piiCandidateCount = columns.filter(
    (column) => column.candidates.classification === 'pii'
  ).length;
  const regulatedCandidateCount = columns.filter(
    (column) => column.candidates.classification === 'regulated'
  ).length;
  const requiredCandidateCount = columns.filter((column) => column.candidates.required).length;

  // TODO: Add alias, validation, source-authority, trust-hint, and sample-presence metadata
  // once non-CSV source profile adapters share the same profile version contract.
  return {
    sourceType: 'csv',
    parser: {
      delimiter,
      quote,
      escape,
      newline,
      headerMode,
      sampledRows: dataRows.length,
      sampledColumns: columnCount,
      truncatedRows: parsed.truncated || input.length > MAX_PARSE_CHARACTERS,
      truncatedColumns,
    },
    columns,
    warnings,
    summary: {
      columnCount: columns.length,
      rowSampleCount: dataRows.length,
      piiCandidateCount,
      regulatedCandidateCount,
      requiredCandidateCount,
      blockingWarningCount: piiCandidateCount + regulatedCandidateCount,
    },
  };
}

function parseRows(
  input: string,
  options: {
    delimiter: ',' | '\t' | ';' | '|';
    quote: '"' | "'";
    escape: '"' | "'" | '\\';
    maxRows: number;
  }
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (quoted) {
      if (char === options.escape && next === options.quote) {
        value += options.quote;
        index += 1;
        continue;
      }
      if (char === options.quote) {
        quoted = false;
        continue;
      }
      value += char;
      continue;
    }

    if (char === options.quote) {
      quoted = true;
      continue;
    }
    if (char === options.delimiter) {
      row.push(value);
      value = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      if (char === '\r' && next === '\n') index += 1;
      if (rows.length >= options.maxRows) {
        return { rows, truncated: true };
      }
      continue;
    }
    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return { rows, truncated: false };
}

function inferColumn(values: string[], headerName: string) {
  const nonEmptyValues = values.map((value) => value.trim()).filter((value) => value.length > 0);
  const emptyRate = values.length === 0 ? 0 : 1 - nonEmptyValues.length / values.length;
  const requiredCandidate = values.length > 0 && nonEmptyValues.length === values.length;
  const classificationCandidate = inferClassification(headerName, nonEmptyValues);
  const valueType = inferValueType(headerName, nonEmptyValues);

  return {
    nonEmptyValues,
    emptyRate,
    requiredCandidate,
    classificationCandidate,
    valueType,
  };
}

function inferClassification(
  headerName: string,
  nonEmptyValues: string[]
): RedactionClassification | undefined {
  if (REGULATED_NAME_PATTERNS.some((pattern) => pattern.test(headerName))) return 'regulated';
  if (PII_NAME_PATTERNS.some((pattern) => pattern.test(headerName))) return 'pii';
  if (nonEmptyValues.some((value) => /^\d{3}-\d{2}-\d{4}$/.test(value))) return 'regulated';
  if (nonEmptyValues.some((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return 'pii';
  return undefined;
}

function inferValueType(headerName: string, nonEmptyValues: string[]): CsvSourceProfileValueType {
  if (nonEmptyValues.length === 0) return 'string';
  if (/phone|mobile|tel/i.test(headerName)) return 'phone';
  if (nonEmptyValues.every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return 'email';
  if (nonEmptyValues.every((value) => /^(true|false|yes|no|0|1)$/i.test(value))) return 'boolean';
  if (nonEmptyValues.every((value) => isJsonText(value))) return 'json';
  if (nonEmptyValues.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return 'number';
  if (nonEmptyValues.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return 'date';
  if (nonEmptyValues.every((value) => !Number.isNaN(Date.parse(value)) && /[tT:]/.test(value))) {
    return 'datetime';
  }
  return 'string';
}

function isJsonText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function detectDelimiter(
  input: string,
  requested: CsvSourceProfileParserOptions['delimiter']
): ',' | '\t' | ';' | '|' {
  if (requested && requested !== 'auto') return requested;
  const firstLines = input.split(/\r?\n/).slice(0, 10);
  const candidates: Array<',' | '\t' | ';' | '|'> = [',', '\t', ';', '|'];
  return (
    candidates
      .map((candidate) => ({
        candidate,
        score: firstLines.reduce((sum, line) => sum + line.split(candidate).length - 1, 0),
      }))
      .sort((left, right) => right.score - left.score)[0]?.candidate ?? ','
  );
}

function detectNewline(
  input: string,
  requested: CsvSourceProfileParserOptions['newline']
): '\n' | '\r\n' {
  if (requested && requested !== 'auto') return requested;
  return input.includes('\r\n') ? '\r\n' : '\n';
}

function resolveHeaderMode(
  rows: string[][],
  requested: CsvSourceProfileParserOptions['headerMode']
): 'first_row' | 'none' {
  if (requested === 'first_row' || requested === 'none') return requested;
  const firstRow = rows[0] ?? [];
  const secondRow = rows[1] ?? [];
  const firstLooksTextual = firstRow.some((value) => /[A-Za-z_]/.test(value));
  const secondLooksData = secondRow.some((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return firstLooksTextual || secondLooksData ? 'first_row' : 'none';
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.min(Math.floor(value), fallback));
}

function createStableColumnId(headerName: string, index: number): string {
  return `csv.${normalizeIdPart(headerName) || `column-${index + 1}`}.${shortHash([
    headerName,
    index,
  ])}`;
}

function normalizeIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function labelFromHeader(value: string): string {
  const normalized = value.replace(/[_\-.]+/g, ' ').trim();
  if (!normalized) return value;
  return normalized
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
