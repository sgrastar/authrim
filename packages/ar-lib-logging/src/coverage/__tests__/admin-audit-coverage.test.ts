import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
  buildAdminAuditCoverageStatusView,
  findAdminAuditCoverageEntry,
  listAdminAuditCoverageGaps,
  summarizeAdminAuditCoverage,
} from '../index';

function extractAuditActions(source: string): string[] {
  const actions = Array.from(source.matchAll(/action:\s*['`]([^'`]+)['`]/g), (match) => match[1])
    .flatMap((action) =>
      action === 'logging.dlq.${action}'
        ? ['logging.dlq.delete', 'logging.dlq.purge']
        : [action]
    )
    .filter(
      (action) =>
        action.startsWith('storage_destination.') ||
        action.startsWith('logging') ||
        action.startsWith('admin_logging.')
    );
  return Array.from(new Set(actions)).sort();
}

function extractStructuredErrorDetailBlocks(source: string): string[] {
  return Array.from(
    source.matchAll(/createAdmin(?:ErrorResponseWithDetails|PermissionErrorResponse)\([^;]+?\);/gs),
    (match) => match[0]
  );
}

function readLoggingControlSource(): string {
  const relativePath = 'packages/ar-management/src/routes/admin-management/logging-control.ts';
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), '..', '..', relativePath),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`logging_control_source_not_found:${relativePath}`);
  }
  return readFileSync(sourcePath, 'utf8');
}

describe('logging admin audit coverage registry', () => {
  it('has no duplicate actions or open gaps in the initial logging registry', () => {
    const actions = LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY.map((entry) => entry.action);

    expect(new Set(actions).size).toBe(actions.length);
    expect(listAdminAuditCoverageGaps()).toEqual([]);
    expect(findAdminAuditCoverageEntry('storage_destination.delete')).toMatchObject({
      status: 'covered',
      critical: true,
    });
  });

  it('tracks every logging-control admin audit action in the registry', () => {
    const source = readLoggingControlSource();
    const sourceActions = extractAuditActions(source);
    const registryActions = LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY.map((entry) => entry.action).sort();

    expect(sourceActions).toEqual(registryActions);
  });

  it('keeps structured error details free of raw secrets and payload bodies', () => {
    const source = readLoggingControlSource();
    const blocks = extractStructuredErrorDetailBlocks(source);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(
        /secret_value|secretValue|credential_value|plaintext|payload_object_ref|body_object_ref|raw_preview|redacted_json|provider_config/i
      );
    }
  });

  it('builds coverage summary and UI-safe status rows', () => {
    const entries = [
      {
        action: 'a.covered',
        surface: 'logging_policies',
        resourceType: 'x',
        status: 'covered' as const,
        critical: true,
      },
      {
        action: 'a.gap',
        surface: 'logging_policies',
        resourceType: 'y',
        status: 'gap_detected' as const,
        critical: false,
      },
    ];

    expect(summarizeAdminAuditCoverage(entries, 1234)).toEqual({
      covered: 1,
      gap_detected: 1,
      acknowledged: 0,
      ignored: 0,
      last_checked_at: 1234,
    });
    expect(buildAdminAuditCoverageStatusView(entries)).toEqual([
      expect.objectContaining({
        operation_id: 'a.covered',
        required_audit: 'admin_audit',
        criticality: 'critical',
        status: 'covered',
      }),
      expect.objectContaining({
        operation_id: 'a.gap',
        criticality: 'normal',
        status: 'gap_detected',
      }),
    ]);
    expect(listAdminAuditCoverageGaps(entries)).toHaveLength(1);
  });
});
