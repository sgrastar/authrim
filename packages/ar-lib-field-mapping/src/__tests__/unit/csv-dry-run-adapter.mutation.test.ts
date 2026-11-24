import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adaptCsvPreview } from '../../adapters/csv';
import { previewCsvDryRun } from '../../previews/csv-dry-run';
import { reason } from '../../core/reason-registry';
import { TEST_CATALOG } from '../../test-support';
import type {
  AdapterResult,
  FieldRef,
  MappingInput,
  MappingRuleGraph,
  MappingResultStatus,
} from '../../core/types';

vi.mock('../../adapters/csv', () => ({ adaptCsvPreview: vi.fn() }));

const adapter = vi.mocked(adaptCsvPreview);

const source: FieldRef = { side: 'source', namespace: 'csv', path: 'email' };
const canonical: FieldRef = {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};

function graphInput(
  targetRef: FieldRef,
  transforms: MappingRuleGraph['transforms'] = [],
  output: MappingRuleGraph['output'] = { edgeIndex: 0 }
): MappingInput {
  const edge = { id: 'edge-1', sourceRef: source, targetRef };
  return {
    catalog: TEST_CATALOG,
    edges: [edge],
    sourceValues: [{ value: 'a@example.test', sourceRef: source }],
    graphRules: [{ id: 'rule-1', targetRef, edges: [edge], transforms, output }],
  };
}

function run(result: AdapterResult<MappingInput>) {
  adapter.mockReturnValue(result);
  return previewCsvDryRun({
    rows: [{ email: 'a@example.test' }],
    columnToPath: { email: 'email' },
    catalog: TEST_CATALOG,
    edges: [],
  });
}

beforeEach(() => {
  adapter.mockReset();
});

describe('previewCsvDryRun with adapter results', () => {
  it('skips the dry run when the adapter produced no input', () => {
    const result = run({
      status: 'partial',
      reasons: [reason('adapter.missing_column')],
    });
    expect(result.rowResults).toEqual([
      {
        rowIndex: 0,
        status: 'partial',
        adapterStatus: 'partial',
        adapterReasons: [reason('adapter.missing_column')],
        dryRun: null,
        canonicalTargetPreview: [],
      },
    ]);
    expect(result.status).toBe('partial');
    expect(result.summary).toEqual({
      totalRows: 1,
      successRows: 0,
      partialRows: 1,
      failedRows: 0,
      adapterErrorRows: 1,
      dryRunErrorRows: 0,
    });
    expect(result.reasonCounts).toEqual([{ code: 'adapter.missing_column', count: 1 }]);
  });

  it('keeps a failed adapter status without an input', () => {
    const result = run({ status: 'failed', reasons: [] });
    expect(result.rowResults[0]?.status).toBe('failed');
    expect(result.status).toBe('failed');
    expect(result.summary).toMatchObject({ failedRows: 1, adapterErrorRows: 1 });
  });

  it.each<MappingResultStatus>(['failed', 'partial', 'success'])(
    'keeps the adapter status %s when the dry run is clean',
    (adapterStatus) => {
      const result = run({ status: adapterStatus, input: graphInput(canonical), reasons: [] });
      expect(result.rowResults[0]?.status).toBe(adapterStatus);
      expect(result.rowResults[0]?.dryRun?.status).toBe('success');
    }
  );

  it('lets a failed dry run override a successful or partial adapter', () => {
    const failing = {
      ...graphInput(canonical),
      validationRules: undefined,
      graphRules: [
        {
          id: 'rule-1',
          targetRef: canonical,
          edges: [{ id: 'edge-1', sourceRef: source, targetRef: canonical }],
          transforms: [],
          output: { edgeIndex: 7 },
        },
      ],
    } satisfies MappingInput;
    for (const adapterStatus of ['success', 'partial', 'failed'] as const) {
      const result = run({ status: adapterStatus, input: failing, reasons: [] });
      expect(result.rowResults[0]?.dryRun?.status).toBe('failed');
      expect(result.rowResults[0]?.status).toBe('failed');
    }
  });

  it('lists transformed canonical targets with their step id and no edge id', () => {
    const result = run({
      status: 'success',
      input: graphInput(
        canonical,
        [{ id: 'trim-step', operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
        { stepIndex: 0 }
      ),
      reasons: [],
    });
    expect(result.rowResults[0]?.canonicalTargetPreview).toEqual([
      {
        action: 'mapped',
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'field.canonical.email',
        edgeId: 'edge-1',
        transformStepId: null,
      },
      {
        action: 'transformed',
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'field.canonical.email',
        edgeId: null,
        transformStepId: 'trim-step',
      },
    ]);
  });

  it('omits targets that are not canonical', () => {
    const destination: FieldRef = { ...canonical, side: 'destination' };
    const result = run({
      status: 'success',
      input: graphInput(
        destination,
        [{ id: 'trim-step', operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
        { stepIndex: 0 }
      ),
      reasons: [],
    });
    expect(result.rowResults[0]?.dryRun?.ruleTrace.map((entry) => entry.action)).toContain(
      'mapped'
    );
    expect(result.rowResults[0]?.canonicalTargetPreview).toEqual([]);
  });

  it('reports no catalog id for canonical targets without one', () => {
    const bare: FieldRef = { side: 'canonical', namespace: 'authrim.profile', path: 'email' };
    const result = run({ status: 'success', input: graphInput(bare), reasons: [] });
    expect(result.rowResults[0]?.canonicalTargetPreview).toEqual([
      {
        action: 'mapped',
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: null,
        edgeId: 'edge-1',
        transformStepId: null,
      },
    ]);
  });
});
