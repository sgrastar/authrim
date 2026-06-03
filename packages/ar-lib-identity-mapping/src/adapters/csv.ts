import { reason } from '../core/reason-registry';
import type { AdapterResult, MappingInput, SourceValueEnvelope } from '../core/types';

export interface CsvPreviewAdapterInput {
  row: Record<string, unknown>;
  columnToPath: Record<string, string>;
  catalog: MappingInput['catalog'];
  edges: MappingInput['edges'];
  requiredColumns?: string[];
}

export function adaptCsvPreview(input: CsvPreviewAdapterInput): AdapterResult<MappingInput> {
  const reasons = [];
  for (const column of input.requiredColumns ?? []) {
    if (!(column in input.row)) {
      reasons.push(reason('adapter.missing_column'));
    }
  }

  const sourceValues: SourceValueEnvelope[] = Object.entries(input.columnToPath).map(
    ([columnName, path]) => ({
      value: input.row[columnName],
      sourceRef: { side: 'inbound', namespace: 'csv', path },
      metadata: { sourceType: 'csv', columnName, csvHeaderName: columnName },
    })
  );

  return {
    status: reasons.some((item) => item.severity === 'critical' || item.severity === 'error')
      ? 'partial'
      : 'success',
    input: {
      catalog: input.catalog,
      edges: input.edges,
      sourceValues,
    },
    reasons,
  };
}
