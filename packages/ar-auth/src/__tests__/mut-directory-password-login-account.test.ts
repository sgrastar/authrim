import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/log-iceberg-emitter')>()),
  emitLogIcebergRow: vi.fn(async () => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).coreMock(o as never)
);
vi.mock('../sign-in-attempt-recording', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().signInAttempt(o as never)
);
vi.mock('../flow-session-profile', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().flowSession(o as never)
);
vi.mock('../direct-auth', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().directAuth(o as never)
);
vi.mock('../human-verification', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().humanVerification(o as never)
);
vi.mock('../registration-policy-gate', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().registrationGate(o as never)
);
vi.mock('../account-provisioning', async (o) =>
  (await import('./helpers/mut-directory-login-harness'))
    .localMocks()
    .accountProvisioning(o as never)
);

import { createDirectoryPasswordLoginHandler } from '../directory-password-login';
import {
  SUBJECT,
  WW_CONNECTOR,
  connectorSettings,
  createContext,
  failedEvents,
  m,
  read,
  resetHarness,
  verdictFetcher,
} from './helpers/mut-directory-login-harness';

const creds = { username: 'alice', password: 'correct' };
const autoProvision = connectorSettings({}, { auto_provision: true });

async function run(
  options: Parameters<typeof createContext>[1] = {},
  verdict: Record<string, unknown> = {},
  body: Record<string, unknown> = creds
) {
  const handler = createDirectoryPasswordLoginHandler(verdictFetcher(verdict));
  return read(await handler(createContext(body, options) as never));
}

function executeCall(fragment: string) {
  return m.coreAdapter.execute.mock.calls.find((call) => String(call[0]).includes(fragment)) as
    | [string, unknown[]]
    | undefined;
}

type Facts = {
  identity: unknown;
  attributes: Record<string, { value: unknown }>;
  groups: unknown[];
  evidence: Record<string, unknown> & {
    source_decisions: Array<{ field: string; reason: string } & Record<string, unknown>>;
  };
};

const unmapped = { status: 409, body: { error: 'directory_identity_unmapped' } };

beforeEach(() => resetHarness());

describe('directory password login: account matching (unrouted)', () => {
  it('rejects a link to a missing user as stale', async () => {
    m.findById.mockResolvedValue(null);
    expect(await run()).toEqual(unmapped);
    expect(m.failures).toEqual([{ reason: 'account_unavailable', userId: null }]);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_identity_link_stale' });
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('records the login on an existing link with the directory facts', async () => {
    await run(
      {},
      {
        attributes: { mail: [' Alice@Example.com '], cn: [' A ', '', 'B'], empty: [' '] },
        group_facts: [{ id: 'g', dn: 'cn=g', display: 'G', source: 'ldap', depth: 0 }],
      }
    );
    const call = executeCall('UPDATE directory_identity_links');
    expect(call?.[1].slice(3)).toEqual(['tenant-a', WW_CONNECTOR, SUBJECT]);
    const facts = JSON.parse(call?.[1][0] as string) as Facts;
    expect(facts.identity).toEqual({
      subject: SUBJECT,
      canonical_username: 'alice@example.com',
      connector_id: WW_CONNECTOR,
    });
    expect(facts.attributes.mail.value).toBe('Alice@Example.com');
    expect(facts.attributes.cn).toEqual({
      value: ['A', 'B'],
      source: 'directory',
      evidence: { attribute: 'cn', reason: 'allowlisted_directory_attribute' },
    });
    expect(facts.attributes.empty).toBeUndefined();
    expect(facts.groups).toHaveLength(1);
    expect(facts.evidence).toMatchObject({
      connector_id: 'campus',
      wordwarden_connector_id: WW_CONNECTOR,
    });
    expect(facts.evidence.source_decisions.map((d) => [d.field, d.reason])).toEqual([
      ['directory.identity.subject', 'directory_identity_fact'],
      ['directory.identity.canonical_username', 'directory_identity_fact'],
      ['directory.attributes.mail', 'allowlisted_directory_attribute'],
      ['directory.attributes.cn', 'allowlisted_directory_attribute'],
      ['directory.groups', 'opt_in_directory_group_facts'],
    ]);
    expect(facts.evidence.source_decisions[0]).toMatchObject({
      chosen_source: 'directory',
      candidate_sources: ['directory'],
      connector_id: WW_CONNECTOR,
    });
  });

  it('truncates directory facts above 32 KiB', async () => {
    await run({}, { attributes: { mail: ['a@x.com'], blob: ['x'.repeat(40_000)] } });
    const facts = JSON.parse(
      executeCall('UPDATE directory_identity_links')?.[1][0] as string
    ) as Facts;
    expect(facts.attributes).toEqual({});
    expect(facts.groups).toEqual([]);
    expect(facts.evidence).toMatchObject({ truncated: true, reason: 'directory_facts_size_limit' });
  });

  it('links an account found by email and signs in', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    m.findByEmail.mockResolvedValue({
      id: 'user_2',
      email: 'alice@example.com',
      name: 'A',
      active: 1,
    });
    const result = await run();
    expect(result.status).toBe(200);
    expect(m.findByEmail).toHaveBeenCalledWith('alice@example.com');
    const insert = executeCall('INSERT INTO directory_identity_links');
    expect(insert?.[1][0]).toMatch(/^dirlink_[0-9a-f-]{36}$/);
    expect(insert?.[1].slice(1, 5)).toEqual(['tenant-a', WW_CONNECTOR, SUBJECT, 'user_2']);
    expect(m.publishDirectoryRoute).not.toHaveBeenCalled();
  });

  it('treats a lost insert race as a link conflict', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    m.findByEmail.mockResolvedValue({
      id: 'user_2',
      email: 'alice@example.com',
      name: 'A',
      active: 1,
    });
    m.coreAdapter.execute.mockResolvedValue({ rowsAffected: 0, success: true });
    expect(await run()).toEqual(unmapped);
    expect(m.failures).toEqual([{ reason: 'account_unavailable', userId: 'user_2' }]);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_identity_link_conflict' });
  });

  it('uses a username containing @ as the email when mail is absent', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    await run(
      {},
      { attributes: {}, subject: { directory_id: SUBJECT, username: ' Bob@Example.com ' } }
    );
    expect(m.findByEmail).toHaveBeenCalledWith('bob@example.com');
  });

  it('does not look up an account by email when the directory gives none', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    const result = await run({}, { attributes: { mail: ['  '] } });
    expect(result).toEqual(unmapped);
    expect(m.findByEmail).not.toHaveBeenCalled();
    expect(m.failures).toEqual([{ reason: 'account_not_linked', userId: null }]);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_identity_unmapped' });
  });
});

describe('directory password login: pending provisioning', () => {
  beforeEach(() => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
  });

  it.each(['rejected', 'linked'])('refuses a %s pending identity', async (status) => {
    m.coreAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('directory_jit_pending_users') ? { status } : null
    );
    expect(await run({ settings: autoProvision })).toEqual(unmapped);
    expect(failedEvents()[0]).toMatchObject({ errorCode: `directory_pending_${status}` });
    expect(executeCall('INSERT INTO directory_jit_pending_users')).toBeUndefined();
  });

  it('refreshes a pending identity and answers provisioning pending', async () => {
    m.coreAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('directory_jit_pending_users') ? { status: 'pending' } : null
    );
    const result = await run(
      { settings: autoProvision },
      { attributes: {}, subject: { directory_id: SUBJECT, username: 'alice' } }
    );
    expect(result).toEqual({
      status: 403,
      body: {
        error: 'directory_provisioning_pending',
        error_description: '管理者の確認が必要です。所属組織の管理者にお問い合わせください。',
      },
    });
    const insert = executeCall('INSERT INTO directory_jit_pending_users');
    expect(insert?.[1][0]).toMatch(/^dirpending_/);
    expect(insert?.[1].slice(1, 5)).toEqual(['tenant-a', WW_CONNECTOR, SUBJECT, 'alice']);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'pending_provisioning_created' });
    expect(m.failures).toEqual([{ reason: 'account_not_linked', userId: null }]);
  });

  it('reports a pending state conflict when the upsert changes nothing', async () => {
    m.coreAdapter.execute.mockResolvedValue({ rowsAffected: 0, success: true });
    expect(await run({ settings: { ...autoProvision, auto_provision: 'true' } })).toEqual(unmapped);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_pending_state_conflict' });
  });
});

describe('directory password login: routed accounts', () => {
  beforeEach(() => {
    m.usesRouted.mockReturnValue(true);
    m.resolveDirectoryAccountRoute.mockResolvedValue(null);
    m.resolveByIdentifier.mockResolvedValue({ legacyUserId: 'user_1' });
    m.publishDirectoryRoute.mockResolvedValue(undefined);
  });

  it('treats a deleted destination route as stale', async () => {
    m.resolveDirectoryAccountRoute.mockRejectedValue(
      Object.assign(new Error('lookup_destination_revalidation_failed'), {
        cause: 'account_inactive',
      })
    );
    expect(await run()).toEqual(unmapped);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_identity_link_stale' });
  });

  it('rethrows other route errors and records service_unavailable', async () => {
    m.resolveDirectoryAccountRoute.mockRejectedValue(new Error('route store down'));
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    await expect(handler(createContext(creds) as never)).rejects.toThrow('route store down');
    expect(m.failures).toEqual([{ reason: 'service_unavailable', userId: null }]);
  });

  it('signs in through a published route whose link names the same user', async () => {
    m.resolveDirectoryAccountRoute.mockResolvedValue({ legacyUserId: 'user_1' });
    expect((await run()).status).toBe(200);
    expect(m.resolveByIdentifier).not.toHaveBeenCalled();
    expect(m.publishDirectoryRoute).not.toHaveBeenCalled();
  });

  it('treats a published route whose link names another user as stale', async () => {
    m.resolveDirectoryAccountRoute.mockResolvedValue({ legacyUserId: 'user_9' });
    expect(await run()).toEqual(unmapped);
  });

  it('answers unmapped when neither route names an account', async () => {
    m.resolveByIdentifier.mockRejectedValue(new Error('account_data_route_not_found'));
    expect(await run()).toEqual(unmapped);
    expect(m.failures[0].reason).toBe('account_not_linked');
  });

  it('answers unmapped when the email route names a missing user', async () => {
    m.findById.mockResolvedValue(null);
    expect(await run()).toEqual(unmapped);
  });

  it('reports a link to another user in the email-routed account as a conflict', async () => {
    m.coreAdapter.queryOne.mockResolvedValue({ user_id: 'user_other' });
    expect(await run()).toEqual(unmapped);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_identity_link_conflict' });
  });

  it('republishes the route of a link whose route was never published', async () => {
    expect((await run()).status).toBe(200);
    expect(m.publishDirectoryRoute).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      userId: 'user_1',
      connectorId: WW_CONNECTOR,
      directorySubject: SUBJECT,
    });
    expect(executeCall('UPDATE directory_identity_links')).toBeDefined();
  });

  it('removes a new link whose route publication was refused', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    m.publishDirectoryRoute.mockRejectedValue(new Error('directory_route_account_mismatch'));
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    const response = await handler(createContext(creds) as never);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Directory sign-in could not be completed. Please try again.',
    });
    const del = executeCall('DELETE FROM directory_identity_links');
    expect(del?.[1]).toEqual(['tenant-a', WW_CONNECTOR, SUBJECT, 'user_1']);
  });

  it('keeps a new link when publication failed for another reason, answering the write fence', async () => {
    m.coreAdapter.queryOne.mockResolvedValue(null);
    m.publishDirectoryRoute.mockRejectedValue(new Error('write_fenced'));
    expect(await run()).toEqual({ status: 503, body: { error: 'tenant_write_fenced' } });
    expect(executeCall('DELETE FROM directory_identity_links')).toBeUndefined();
  });

  it('keeps an existing link when its republication is refused', async () => {
    m.publishDirectoryRoute.mockRejectedValue(new Error('directory_route_account_mismatch'));
    expect((await run()).status).toBe(503);
    expect(executeCall('DELETE FROM directory_identity_links')).toBeUndefined();
  });
});
