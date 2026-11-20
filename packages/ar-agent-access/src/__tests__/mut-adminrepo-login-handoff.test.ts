import { describe, expect, it } from 'vitest';
import type {
  ConsumeAdminAgentLoginHandoffInput,
  CreateAdminAgentLoginHandoffInput,
  IssueAdminAgentLoginHandoffInput,
} from '../core/repositories/admin-agent-access-repository';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const createInput = (
  overrides: Partial<CreateAdminAgentLoginHandoffInput> = {}
): CreateAdminAgentLoginHandoffInput => ({
  id: 'handoff-1',
  targetTenantId: 'tenant-1',
  targetOrigin: 'https://tenant.example.com',
  authorizationPath: '/oauth/admin-agent/authorize?client_id=c',
  browserBindingHash: 'binding',
  transitionId: 'transition-1',
  createdAt: 100,
  expiresAt: 200,
  audit: mutAudit('audit-1'),
  ...overrides,
});

const issueInput = (
  overrides: Partial<IssueAdminAgentLoginHandoffInput> = {}
): IssueAdminAgentLoginHandoffInput => ({
  id: 'handoff-1',
  targetTenantId: 'tenant-1',
  sourceSessionId: 'session-1',
  sourceSessionHash: 'session-hash',
  adminUserId: 'admin-1',
  codeHash: 'code-hash',
  transitionId: 'transition-2',
  issuedAt: 150,
  expiresAt: 180,
  audit: mutAudit('audit-2'),
  ...overrides,
});

type TargetSession = ConsumeAdminAgentLoginHandoffInput['targetSession'];
const consumeInput = (
  session: Partial<TargetSession> = {}
): ConsumeAdminAgentLoginHandoffInput => ({
  id: 'handoff-1',
  targetTenantId: 'tenant-1',
  codeHash: 'code-hash',
  transitionId: 'transition-3',
  consumedAt: 160,
  targetSession: {
    id: 'session-2',
    tenantId: 'tenant-1',
    adminUserId: 'admin-1',
    parentSessionId: 'session-1',
    parentSessionHash: 'session-hash',
    createdAt: 160,
    expiresAt: 1000,
    mfaVerifiedAt: 160,
    ...session,
  },
  audit: mutAudit('audit-3'),
});

describe('createLoginHandoff', () => {
  it('writes a pending handoff guarded audit for a valid same-origin continuation', async () => {
    const { adapter, repository } = mutRepo();
    await repository.createLoginHandoff(createInput());
    const [insert, audit] = adapter.batches[0];
    expect(insert.sql).toContain("VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)");
    expect(insert.params).toEqual([
      'handoff-1',
      'tenant-1',
      'https://tenant.example.com',
      '/oauth/admin-agent/authorize?client_id=c',
      'binding',
      'transition-1',
      100,
      200,
    ]);
    expect(audit.sql).toContain(
      "FROM admin_agent_login_handoffs WHERE id = ? AND last_transition_id = ? AND status = 'pending'"
    );
    expect(audit.params?.slice(-2)).toEqual(['handoff-1', 'transition-1']);
  });

  it.each<[string, Partial<CreateAdminAgentLoginHandoffInput>]>([
    ['an unparsable origin', { targetOrigin: 'not a url' }],
    ['a blank tenant', { targetTenantId: '   ' }],
    ['a non-canonical origin', { targetOrigin: 'https://tenant.example.com/' }],
    [
      'a plain-http origin',
      {
        targetOrigin: 'http://tenant.example.com',
        authorizationPath: '/oauth/admin-agent/authorize',
      },
    ],
    [
      'a cross-origin continuation',
      { authorizationPath: 'https://evil.example.com/oauth/admin-agent/authorize' },
    ],
    ['another continuation path', { authorizationPath: '/oauth/authorize' }],
    ['a continuation fragment', { authorizationPath: '/oauth/admin-agent/authorize#x' }],
    ['an expiry equal to creation', { expiresAt: 100 }],
  ])('rejects %s before writing', async (_name, overrides) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.createLoginHandoff(createInput(overrides))).rejects.toThrow(
      new TypeError('Invalid Admin Agent login handoff')
    );
    expect(adapter.batches).toHaveLength(0);
  });
});

describe('issueLoginHandoff', () => {
  it('rejects a handoff that would already be expired at issuance', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.issueLoginHandoff(issueInput({ expiresAt: 150 }))).rejects.toThrow(
      new TypeError('Issued Admin Agent login handoff must expire in the future')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('reports success only when exactly the pending row was transitioned', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.issueLoginHandoff(issueInput())).resolves.toBe(true);
    expect(adapter.batches[0][0].params?.slice(-3)).toEqual(['handoff-1', 'tenant-1', 150]);
    adapter.batchRowsAffected.push([0]);
    await expect(repository.issueLoginHandoff(issueInput())).resolves.toBe(false);
  });
});

describe('consumeLoginHandoff', () => {
  it('creates the derived session with optional client metadata and passkey evidence', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.consumeLoginHandoff(
        consumeInput({ ipAddress: '192.0.2.1', userAgent: 'UA', passkeyCredentialId: 'pk-1' })
      )
    ).resolves.toBe(true);
    const session = adapter.batches[0][1];
    expect(session.params?.slice(0, 13)).toEqual([
      'session-2',
      'tenant-1',
      'admin-1',
      '192.0.2.1',
      'UA',
      160,
      1000,
      160,
      160,
      160,
      'pk-1',
      'session-1',
      'tenant-1',
    ]);
  });

  it('stores null optional metadata and reports a lost CAS as false', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0]);
    await expect(repository.consumeLoginHandoff(consumeInput())).resolves.toBe(false);
    expect(adapter.batches[0][1].params?.slice(3, 5)).toEqual([null, null]);
    expect(adapter.batches[0][1].params?.[10]).toBeNull();
  });

  it.each<[string, Partial<TargetSession>]>([
    ['a session that expires at consumption', { expiresAt: 160 }],
    ['a blank parent session ID', { parentSessionId: ' ' }],
    ['a blank parent session hash', { parentSessionHash: ' ' }],
    ['a session equal to its parent', { id: 'session-1' }],
    ['a blank Admin user', { adminUserId: ' ' }],
    ['a blank tenant', { tenantId: ' ' }],
    ['a session created after consumption', { createdAt: 161 }],
    ['MFA verified after consumption', { mfaVerifiedAt: 161 }],
  ])('rejects %s', async (_name, session) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.consumeLoginHandoff(consumeInput(session))).rejects.toThrow(
      new TypeError('Invalid derived Admin session for login handoff')
    );
    expect(adapter.batches).toHaveLength(0);
  });
});

describe('login handoff reads, purge and audit', () => {
  it('maps a stored handoff row and returns null for a missing one', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({
      id: 'handoff-1',
      target_tenant_id: 'tenant-1',
      target_origin: 'https://t',
      authorization_path: '/p',
      status: 'issued',
      browser_binding_hash: 'b',
      source_session_id: null,
      source_session_hash: 'h',
      admin_user_id: 'admin-1',
      code_hash: 'c',
      last_transition_id: 't',
      created_at: 1,
      expires_at: 2,
      issued_at: 3,
      consumed_at: null,
    });
    await expect(repository.getLoginHandoffByCodeHash('c')).resolves.toEqual({
      id: 'handoff-1',
      targetTenantId: 'tenant-1',
      targetOrigin: 'https://t',
      authorizationPath: '/p',
      status: 'issued',
      browserBindingHash: 'b',
      sourceSessionId: undefined,
      sourceSessionHash: 'h',
      adminUserId: 'admin-1',
      codeHash: 'c',
      lastTransitionId: 't',
      createdAt: 1,
      expiresAt: 2,
      issuedAt: 3,
      consumedAt: undefined,
    });
    expect(adapter.calls[0].params).toEqual(['c']);
    await expect(repository.getLoginHandoffById('missing')).resolves.toBeNull();
  });

  it('purges consumed and expired handoffs older than the cutoff and returns the count', async () => {
    const { adapter, repository } = mutRepo();
    adapter.executeResults.push({ rowsAffected: 4, success: true });
    await expect(repository.purgeLoginHandoffs(500)).resolves.toBe(4);
    expect(adapter.calls[0].sql).toContain('DELETE FROM admin_agent_login_handoffs');
    expect(adapter.calls[0].sql).toContain("status IN ('pending', 'issued') AND expires_at < ?");
    expect(adapter.calls[0].params).toEqual([500, 500]);
  });

  it('writes a standalone audit through the configured writer', async () => {
    const { adapter, repository } = mutRepo();
    await repository.writeAudit(mutAudit('audit-standalone'));
    expect(adapter.batches).toHaveLength(1);
    expect(adapter.batches[0][0].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.batches[0][0].params?.[0]).toBe('audit-standalone');
  });
});
