import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeJson,
  parseAgentAccessSettings,
  sha256Base64Url,
  type AdminAgentAuditWrite,
} from '../core';
import { CloudflareDurableObjectRateLimiter } from '../platform/cloudflare/durable-object-rate-limiter';
import { CloudflareAgentMcpAdmissionAuditAdapter } from '../platform/cloudflare/mcp-admission-audit';
import { CloudflareAgentSettingsProvider } from '../platform/cloudflare/tenant-settings';
import type { AgentMcpAdmissionAuditEvent } from '../platform/ports';

describe('CloudflareDurableObjectRateLimiter', () => {
  function limiter() {
    const incrementRpc = vi.fn(async () => ({ allowed: true, current: 3, limit: 2, resetAt: 9 }));
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ incrementRpc })),
    };
    return { incrementRpc, namespace, limiter: new CloudflareDurableObjectRateLimiter(namespace) };
  }

  it('accepts the minimum limit, window and unit cost and never reports negative remaining', async () => {
    const { incrementRpc, namespace, limiter: rate } = limiter();
    await expect(rate.consume({ key: 'k', limit: 1, windowSeconds: 1, cost: 1 })).resolves.toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 9,
    });
    expect(namespace.idFromName).toHaveBeenCalledWith('agent-access:k');
    expect(incrementRpc).toHaveBeenCalledWith('k', { windowSeconds: 1, maxRequests: 1 });
  });

  it.each([
    ['an empty key', { key: '' }],
    ['a fractional limit', { limit: 1.5 }],
    ['a zero limit', { limit: 0 }],
    ['a fractional window', { windowSeconds: 1.5 }],
    ['a zero window', { windowSeconds: 0 }],
    ['a non-unit cost', { cost: 2 }],
  ])('rejects %s', async (_name, change) => {
    const { incrementRpc, limiter: rate } = limiter();
    await expect(
      rate.consume({ key: 'k', limit: 5, windowSeconds: 60, ...change })
    ).rejects.toThrow(new TypeError('Invalid Agent rate-limit request'));
    expect(incrementRpc).not.toHaveBeenCalled();
  });
});

describe('CloudflareAgentMcpAdmissionAuditAdapter', () => {
  const base: AgentMcpAdmissionAuditEvent = {
    eventType: 'agent.mcp.admission.rate_limited',
    occurredAt: 100,
    correlationId: 'corr-1',
    outcome: 'denied',
    httpStatus: 429,
    method: 'POST',
    host: 'auth.example',
    tenantId: 'tenant-1',
    clientIpHash: 'ip_x',
    sessionIdHash: undefined,
    details: { code: 'X' },
  };

  async function persisted(event: AgentMcpAdmissionAuditEvent, createId?: () => string) {
    const writeAudit = vi.fn(async (_audit: AdminAgentAuditWrite): Promise<void> => undefined);
    await new CloudflareAgentMcpAdmissionAuditAdapter({ writeAudit }, createId).write(event);
    return writeAudit.mock.calls[0]?.[0];
  }

  it('digests the purpose-tagged event without undefined fields', async () => {
    const audit = await persisted(base, () => 'audit-1');
    const { sessionIdHash: _omitted, ...defined } = base;
    const digest = await sha256Base64Url(
      canonicalizeJson({ purpose: 'authrim-agent-admission-audit-v1', ...defined })
    );
    expect(audit).toMatchObject({
      id: 'audit-1',
      severity: 'warn',
      result: 'failure',
      resourceId: 'auth.example',
      metadata: { event_digest: digest, session_id_hash: null, code: 'X' },
    });
  });

  it.each([
    ['failed', 'error', 'failure'],
    ['success', 'info', 'success'],
  ] as const)('maps a %s outcome to severity %s', async (outcome, severity, result) => {
    await expect(persisted({ ...base, outcome })).resolves.toMatchObject({ severity, result });
  });

  it('generates audit_ ids by default and skips persistence without a tenant', async () => {
    const audit = await persisted(base);
    expect(audit?.id).toMatch(/^audit_[0-9a-f-]{36}$/u);
    await expect(persisted({ ...base, tenantId: undefined })).resolves.toBeUndefined();
  });
});

describe('CloudflareAgentSettingsProvider', () => {
  it('uses defaults plus the environment flag when no settings store is bound', async () => {
    await expect(
      new CloudflareAgentSettingsProvider({ ENABLE_AGENT_MCP: 'true' }).get('t')
    ).resolves.toEqual({ ...parseAgentAccessSettings(null), enabled: true });
    await expect(new CloudflareAgentSettingsProvider({}).get('t')).resolves.toMatchObject({
      enabled: false,
    });
  });

  it('reads the tenant agent-access document', async () => {
    const get = vi.fn(async () => '{"agent.mcp.enabled":true}');
    await expect(
      new CloudflareAgentSettingsProvider({ SETTINGS: { get } }).get('t-4')
    ).resolves.toMatchObject({ enabled: true });
    expect(get).toHaveBeenCalledWith('settings:tenant:t-4:agent-access');
  });

  it.each(['[1]', '"text"', 'null'])('rejects a non-object settings document %s', async (raw) => {
    const get = vi.fn(async () => raw);
    await expect(
      new CloudflareAgentSettingsProvider({ AUTHRIM_CONFIG: { get } }).get('t')
    ).rejects.toThrow('Invalid Agent settings record');
  });
});
