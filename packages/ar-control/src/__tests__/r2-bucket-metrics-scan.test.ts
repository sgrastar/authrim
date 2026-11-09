import { describe, expect, it, vi } from 'vitest';
import { scanControlR2BucketMetrics } from '../r2-bucket-metrics';
import type { ControlEnv } from '../types';

interface StoredReport {
  objectCount: number;
  totalBytes: number;
  oldestObjectAt: number | null;
  methods: Record<string, number>;
  scanComplete: boolean;
  measuredAt: number;
  reportedAt: number;
}

function scanFixture(initial?: { state?: string | null; report?: StoredReport | null }) {
  let state = initial?.state ?? null;
  let report = initial?.report ?? null;
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          if (sql.includes('FROM control_r2_metric_scan_state')) {
            return (state === null ? null : { accumulator_json: state }) as T | null;
          }
          if (sql.includes('FROM control_r2_bucket_metric_reports')) {
            return (
              report === null
                ? null
                : { scan_complete: report.scanComplete ? 1 : 0, reported_at: report.reportedAt }
            ) as T | null;
          }
          throw new Error('unexpected_scan_query');
        },
        async run() {
          if (sql.includes('INSERT INTO control_r2_bucket_metric_reports')) {
            report = {
              objectCount: values[3] as number,
              totalBytes: values[4] as number,
              oldestObjectAt: values[5] as number | null,
              methods: JSON.parse(values[6] as string) as Record<string, number>,
              scanComplete: values[9] === 1,
              measuredAt: values[10] as number,
              reportedAt: values[11] as number,
            };
          } else if (sql.includes('INSERT INTO control_r2_metric_scan_state')) {
            state = values[1] as string;
          } else if (sql.includes('DELETE FROM control_r2_metric_scan_state')) {
            state = null;
          } else {
            throw new Error('unexpected_scan_mutation');
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(bound: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(bound.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  const list = vi.fn();
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: database,
    MIGRATION_RELEASES: { list },
  } as unknown as ControlEnv;
  return {
    env,
    list,
    statements,
    get state() {
      return state;
    },
    get report() {
      return report;
    },
  };
}

describe('Control release artifact R2 metric scan', () => {
  it('persists a partial accumulator and resumes the next page without double counting', async () => {
    const fixture = scanFixture();
    fixture.list
      .mockResolvedValueOnce({
        objects: [
          { size: 10, uploaded: new Date(800) },
          { size: 20, uploaded: new Date(600) },
        ],
        truncated: true,
        cursor: 'next-page',
      })
      .mockResolvedValueOnce({
        objects: [{ size: 5, uploaded: new Date(700) }],
        truncated: false,
        cursor: undefined,
      });

    await scanControlR2BucketMetrics(fixture.env, 1_000);
    expect(fixture.list).toHaveBeenCalledWith({ limit: 1000, cursor: undefined });
    expect(fixture.report).toMatchObject({
      objectCount: 2,
      totalBytes: 30,
      oldestObjectAt: 600,
      methods: { 'release-artifact': 2 },
      scanComplete: false,
      reportedAt: 1_000,
    });
    expect(JSON.parse(fixture.state ?? '{}')).toMatchObject({ cursor: 'next-page' });

    await scanControlR2BucketMetrics(fixture.env, 2_000);
    expect(fixture.list).toHaveBeenLastCalledWith({ limit: 1000, cursor: 'next-page' });
    expect(fixture.report).toMatchObject({
      objectCount: 3,
      totalBytes: 35,
      oldestObjectAt: 600,
      methods: { 'release-artifact': 3 },
      scanComplete: true,
      measuredAt: 2_000,
    });
    expect(fixture.state).toBeNull();
  });

  it('does not rescan a recently completed inventory', async () => {
    const fixture = scanFixture({
      report: {
        objectCount: 1,
        totalBytes: 10,
        oldestObjectAt: 500,
        methods: { 'release-artifact': 1 },
        scanComplete: true,
        measuredAt: 1_000,
        reportedAt: 1_000,
      },
    });

    await scanControlR2BucketMetrics(fixture.env, 1_000 + 6 * 60 * 60 * 1000 - 1);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.report?.reportedAt).toBe(1_000);
  });

  it('restarts a corrupt accumulator without passing its contents to R2', async () => {
    const fixture = scanFixture({ state: '{invalid-json' });
    fixture.list.mockResolvedValue({
      objects: [{ size: 8, uploaded: null }],
      truncated: false,
      cursor: undefined,
    });

    await scanControlR2BucketMetrics(fixture.env, 5_000);
    expect(fixture.list).toHaveBeenCalledWith({ limit: 1000, cursor: undefined });
    expect(fixture.report).toMatchObject({
      objectCount: 1,
      totalBytes: 8,
      oldestObjectAt: 5_000,
      scanComplete: true,
    });
    expect(fixture.state).toBeNull();
  });

  it('does not touch storage when the environment or release bucket is unavailable', async () => {
    const fixture = scanFixture();
    await scanControlR2BucketMetrics({ ...fixture.env, AUTHRIM_ENVIRONMENT_NAME: '' });
    await scanControlR2BucketMetrics({
      ...fixture.env,
      MIGRATION_RELEASES: undefined,
    } as unknown as ControlEnv);
    expect(fixture.statements).toEqual([]);
    expect(fixture.list).not.toHaveBeenCalled();
  });
});
