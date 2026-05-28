import { adaptCsvPreview } from '../adapters/csv';
import { dryRunMapping } from '../core/dry-run';
import { findCatalogEntry } from '../core/catalog';
import type {
  DryRunResult,
  FieldCatalogBundle,
  FieldRef,
  FingerprintProvider,
  MappingResultStatus,
  MappingRuleEdge,
  MappingTransformStep,
  ReasonCode,
  RuleTraceEntry,
  ValidationRule,
} from '../core/types';

export interface CsvDryRunPreviewInput {
  rows: Array<Record<string, unknown>>;
  columnToPath: Record<string, string>;
  catalog: FieldCatalogBundle;
  edges: MappingRuleEdge[];
  transforms?: MappingTransformStep[];
  validationRules?: ValidationRule[];
  requiredColumns?: string[];
  fingerprintProvider?: FingerprintProvider;
  maxRows?: number;
}

export interface CsvHeaderSuggestion {
  columnName: string;
  mapped: boolean;
  suggestedPath: string;
  catalogEntryId: string | null;
  classification: string | null;
  valueType: string | null;
}

export interface CsvCanonicalTargetPreview {
  action: RuleTraceEntry['action'];
  namespace: string;
  path: string;
  catalogEntryId: string | null;
  edgeId: string | null;
  transformStepId: string | null;
}

export interface CsvDryRunPreviewRowResult {
  rowIndex: number;
  status: MappingResultStatus;
  adapterStatus: MappingResultStatus;
  adapterReasons: ReasonCode[];
  dryRun: DryRunResult | null;
  canonicalTargetPreview: CsvCanonicalTargetPreview[];
}

export interface CsvDryRunPreviewResult {
  status: MappingResultStatus;
  summary: {
    totalRows: number;
    successRows: number;
    partialRows: number;
    failedRows: number;
    adapterErrorRows: number;
    dryRunErrorRows: number;
  };
  headerSuggestions: CsvHeaderSuggestion[];
  rowResults: CsvDryRunPreviewRowResult[];
  reasonCounts: Array<{ code: string; count: number }>;
}

export function previewCsvDryRun(input: CsvDryRunPreviewInput): CsvDryRunPreviewResult {
  const maxRows = input.maxRows ?? 100;
  const rows = input.rows.slice(0, maxRows);
  const rowResults = rows.map((row, rowIndex) => previewCsvDryRunRow(input, row, rowIndex));
  const reasonCounts = new Map<string, number>();

  for (const result of rowResults) {
    for (const reason of result.adapterReasons) {
      reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1);
    }
    for (const reason of result.dryRun?.reasons ?? []) {
      reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1);
    }
  }

  const failedRows = rowResults.filter((row) => row.status === 'failed').length;
  const partialRows = rowResults.filter((row) => row.status === 'partial').length;
  const successRows = rowResults.filter((row) => row.status === 'success').length;

  return {
    status: failedRows > 0 ? 'failed' : partialRows > 0 ? 'partial' : 'success',
    summary: {
      totalRows: rowResults.length,
      successRows,
      partialRows,
      failedRows,
      adapterErrorRows: rowResults.filter((row) => row.adapterStatus !== 'success').length,
      dryRunErrorRows: rowResults.filter(
        (row) => row.dryRun?.status === 'partial' || row.dryRun?.status === 'failed'
      ).length,
    },
    headerSuggestions: buildHeaderSuggestions(input),
    rowResults,
    reasonCounts: Array.from(reasonCounts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
  };
}

function previewCsvDryRunRow(
  input: CsvDryRunPreviewInput,
  row: Record<string, unknown>,
  rowIndex: number
): CsvDryRunPreviewRowResult {
  const adapter = adaptCsvPreview({
    row,
    columnToPath: input.columnToPath,
    catalog: input.catalog,
    edges: input.edges,
    requiredColumns: input.requiredColumns,
  });

  if (!adapter.input) {
    return {
      rowIndex,
      status: adapter.status,
      adapterStatus: adapter.status,
      adapterReasons: adapter.reasons,
      dryRun: null,
      canonicalTargetPreview: [],
    };
  }

  const dryRun = dryRunMapping({
    ...adapter.input,
    transforms: input.transforms,
    validationRules: input.validationRules,
    fingerprintProvider: input.fingerprintProvider,
  });
  const status = mergeStatus(adapter.status, dryRun.status);

  return {
    rowIndex,
    status,
    adapterStatus: adapter.status,
    adapterReasons: adapter.reasons,
    dryRun,
    canonicalTargetPreview: buildCanonicalTargetPreview(dryRun.ruleTrace),
  };
}

function mergeStatus(
  adapterStatus: MappingResultStatus,
  dryRunStatus: MappingResultStatus
): MappingResultStatus {
  if (adapterStatus === 'failed' || dryRunStatus === 'failed') {
    return 'failed';
  }
  if (adapterStatus === 'partial' || dryRunStatus === 'partial') {
    return 'partial';
  }
  return 'success';
}

function buildCanonicalTargetPreview(trace: RuleTraceEntry[]): CsvCanonicalTargetPreview[] {
  return trace
    .filter(
      (entry) =>
        (entry.action === 'mapped' || entry.action === 'transformed') &&
        entry.fieldRef?.side === 'canonical'
    )
    .map((entry) => ({
      action: entry.action,
      namespace: entry.fieldRef?.namespace ?? '',
      path: entry.fieldRef?.path ?? '',
      catalogEntryId: entry.fieldRef?.catalogEntryId ?? null,
      edgeId: entry.edgeId ?? null,
      transformStepId: entry.transformStepId ?? null,
    }));
}

function buildHeaderSuggestions(input: CsvDryRunPreviewInput): CsvHeaderSuggestion[] {
  const headers = new Set<string>([
    ...Object.keys(input.columnToPath),
    ...input.rows.flatMap((row) => Object.keys(row)),
  ]);

  return Array.from(headers)
    .sort((left, right) => left.localeCompare(right))
    .map((columnName) => {
      const suggestedPath = input.columnToPath[columnName] ?? normalizeColumnName(columnName);
      const catalogRef: FieldRef = { side: 'inbound', namespace: 'csv', path: suggestedPath };
      const catalogEntry = findCatalogEntry(input.catalog, catalogRef);
      return {
        columnName,
        mapped: columnName in input.columnToPath,
        suggestedPath,
        catalogEntryId: catalogEntry?.id ?? null,
        classification: catalogEntry?.classification ?? null,
        valueType: catalogEntry?.valueType ?? null,
      };
    });
}

function normalizeColumnName(columnName: string): string {
  const tokens = columnName
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

  if (tokens.length === 0) {
    return columnName.trim();
  }

  return tokens
    .map((token, index) =>
      index === 0 ? token : `${token.charAt(0).toUpperCase()}${token.slice(1)}`
    )
    .join('');
}
