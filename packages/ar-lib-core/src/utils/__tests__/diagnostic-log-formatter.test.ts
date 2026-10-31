import { describe, expect, it } from 'vitest';
import {
  formatAsJSON,
  formatAsJSONL,
  formatAsText,
  toOIDFFormatBatch,
} from '../diagnostic-log-formatter';
import type { DiagnosticLogEntry } from '../../services/diagnostic/types';

const baseTimestamp = Date.UTC(2026, 3, 21, 0, 0, 0);

const logs: DiagnosticLogEntry[] = [
  {
    id: 'req-1',
    diagnosticSessionId: 'session-a',
    flowId: 'flow-a',
    tenantId: 'tenant-1',
    clientId: 'rp-client',
    category: 'http-request',
    level: 'debug',
    timestamp: baseTimestamp,
    method: 'GET',
    path: '/authorize',
    query: {
      response_type: 'code',
      client_id: 'rp-client',
    },
    headers: {
      'content-type': 'application/json',
    },
  },
  {
    id: 'tok-1',
    diagnosticSessionId: 'session-a',
    flowId: 'flow-a',
    tenantId: 'tenant-1',
    clientId: 'rp-client',
    category: 'token-validation',
    level: 'error',
    timestamp: baseTimestamp + 1_000,
    step: 'issuer-check',
    tokenType: 'id_token',
    result: 'fail',
    expected: 'https://issuer.example.com',
    actual: 'https://unexpected.example.com',
    errorMessage: 'issuer mismatch',
    details: {
      issuer: 'https://unexpected.example.com',
    },
  },
  {
    id: 'auth-1',
    diagnosticSessionId: 'session-b',
    flowId: 'flow-b',
    tenantId: 'tenant-1',
    clientId: 'rp-client',
    category: 'auth-decision',
    level: 'warn',
    timestamp: baseTimestamp + 2_000,
    decision: 'deny',
    reason: 'invalid_iss',
    flow: 'authorization_code',
    context: {
      error: 'invalid_iss',
    },
  },
];

describe('diagnostic-log-formatter', () => {
  it('converts diagnostic logs into OIDF-style entries with filtering', () => {
    const formatted = toOIDFFormatBatch(logs, {
      sessionIds: ['session-a'],
      categories: ['token-validation', 'http-request'],
      sortMode: 'timeline',
      sortOrder: 'asc',
    });

    expect(formatted).toHaveLength(2);
    expect(formatted[0]).toMatchObject({
      sessionId: 'session-a',
      category: 'http-request',
      event: 'http_request',
    });
    expect(formatted[1]).toMatchObject({
      sessionId: 'session-a',
      category: 'token-validation',
      event: 'token_validation_issuer-check',
      details: {
        tokenType: 'id_token',
        result: 'fail',
        expected: 'https://issuer.example.com',
        actual: 'https://unexpected.example.com',
        errorMessage: 'issuer mismatch',
        issuer: 'https://unexpected.example.com',
      },
    });
  });

  it('formats JSONL with one OIDF entry per line', () => {
    const output = formatAsJSONL(logs, { sortMode: 'timeline' });
    const lines = output.split('\n');

    expect(lines).toHaveLength(3);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;

    expect(first.event).toBe('http_request');
    expect(second.event).toBe('token_validation_issuer-check');
  });

  it('filters evidence by Authrim-generated flow ID', () => {
    const formatted = toOIDFFormatBatch(logs, {
      flowIds: ['flow-b'],
      sortMode: 'timeline',
    });

    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toMatchObject({
      category: 'auth-decision',
      event: 'auth_decision_deny',
      details: {
        flowId: 'flow-b',
      },
    });
  });

  it('formats JSON exports with an array of OIDF entries', () => {
    const output = formatAsJSON(logs, { sortMode: 'timeline' });
    const parsed = JSON.parse(output) as Array<Record<string, unknown>>;

    expect(parsed).toHaveLength(3);
    expect(parsed[2]).toMatchObject({
      category: 'auth-decision',
      event: 'auth_decision_deny',
    });
  });

  it('formats text exports grouped by session by default', () => {
    const output = formatAsText(logs);

    expect(output).toContain('OIDF Conformance Test - Diagnostic Logs');
    expect(output).toContain('Session: session-a');
    expect(output).toContain('Session: session-b');
    expect(output).toContain('token_validation_issuer-check');
    expect(output).toContain('auth_decision_deny');
  });

  describe('naming which side wrote an entry', () => {
    const labelled = logs.map((entry, index) => ({
      ...entry,
      source: index === 0 ? ('sdk' as const) : ('server' as const),
    })) as DiagnosticLogEntry[];

    it('leaves the source out unless asked, so an export is what it always was', () => {
      const formatted = toOIDFFormatBatch(labelled, { sortMode: 'timeline' });
      for (const entry of formatted) expect(entry).not.toHaveProperty('source');
      expect(formatAsText(labelled, { sortMode: 'timeline' })).not.toContain('Source:');
      expect(JSON.stringify(formatted)).toBe(
        JSON.stringify(toOIDFFormatBatch(logs, { sortMode: 'timeline' }))
      );
    });

    it('shows the source of each entry when asked, in one timeline', () => {
      const formatted = toOIDFFormatBatch(labelled, { sortMode: 'timeline', includeSource: true });
      expect(formatted.map((entry) => entry.source)).toEqual(['sdk', 'server', 'server']);
      const text = formatAsText(labelled, { sortMode: 'timeline', includeSource: true });
      expect(text).toContain('Source: sdk');
      expect(text).toContain('Source: server');
    });

    it('leaves an entry with no source unlabelled', () => {
      const formatted = toOIDFFormatBatch(logs, { sortMode: 'timeline', includeSource: true });
      for (const entry of formatted) expect(entry).not.toHaveProperty('source');
    });
  });

  it('includes the token hash of a token validation entry, so exports can be matched on it', () => {
    const withHash = logs.map((entry) =>
      entry.category === 'token-validation' ? { ...entry, tokenHash: 'abcdef012345' } : entry
    ) as DiagnosticLogEntry[];
    const formatted = toOIDFFormatBatch(withHash, { sortMode: 'timeline' });
    const token = formatted.find((entry) => entry.category === 'token-validation');
    expect(token?.details.tokenHash).toBe('abcdef012345');
    const without = toOIDFFormatBatch(logs, { sortMode: 'timeline' });
    expect(
      without.find((entry) => entry.category === 'token-validation')?.details
    ).not.toHaveProperty('tokenHash', expect.anything());
  });
});
