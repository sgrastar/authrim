import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({ execa: execaMock }));

import {
  createD1Database,
  createKVNamespace,
  createQueue,
  generateAndStoreSetupToken,
  getProvisioningResourceAdoptionPolicy,
  listQueues,
} from '../core/cloudflare.js';

function commandResult(stdout = '', stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}

const WRANGLER_OAUTH_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const WRANGLER_AUTH_ERROR =
  'Authentication error [code: 10000] while requesting ' +
  `https://api.cloudflare.com/client/v4/accounts/${WRANGLER_OAUTH_ACCOUNT_ID}/d1/database`;
const WRANGLER_WHOAMI_RESULT = commandResult(
  `You are logged in with an OAuth Token.\nAccount ID: ${WRANGLER_OAUTH_ACCOUNT_ID}`
);

describe('Cloudflare provisioning idempotency', () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalD1Token = process.env.CLOUDFLARE_D1_API_TOKEN;

  beforeEach(() => {
    execaMock.mockReset();
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_D1_API_TOKEN;
  });

  afterEach(() => {
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    if (originalD1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
    else process.env.CLOUDFLARE_D1_API_TOKEN = originalD1Token;
    vi.unstubAllGlobals();
  });

  it('waits for a successful D1 create to become visible with the same provider ID', async () => {
    const createdId = '11111111-1111-4111-8111-111111111111';
    const onProviderIdentityIdentified = vi.fn(async () => undefined);
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: createdId }]))
      );

    await expect(
      createD1Database('test-authrim-core-db', undefined, { onProviderIdentityIdentified })
    ).resolves.toEqual({
      id: createdId,
      name: 'test-authrim-core-db',
    });
    expect(onProviderIdentityIdentified).toHaveBeenCalledWith({ id: createdId });
    expect(execaMock).toHaveBeenCalledTimes(4);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(1);
  });

  it('fails closed when an ambiguous D1 create returns no immutable ID', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockRejectedValueOnce(new Error('UND_ERR_SOCKET: response lost after commit'));

    await expect(createD1Database('test-authrim-core-db')).rejects.toThrow(
      'returned no immutable database ID'
    );
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(1);
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('adopts an ambiguous D1 create only when the error carries the exact immutable ID', async () => {
    const createdId = '22222222-2222-4222-8222-222222222222';
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockRejectedValueOnce(new Error(`UND_ERR_SOCKET after response {"uuid":"${createdId}"}`))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: createdId }]))
      );

    await expect(createD1Database('test-authrim-core-db')).resolves.toEqual({
      id: createdId,
      name: 'test-authrim-core-db',
    });
  });

  it('fails closed when D1 readback identity differs from a successful create response', async () => {
    const createdId = '33333333-3333-4333-8333-333333333333';
    const otherId = '44444444-4444-4444-8444-444444444444';
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: otherId }]))
      );

    await expect(createD1Database('test-authrim-core-db')).rejects.toThrow(
      'does not match the provider create response'
    );
    expect(execaMock).toHaveBeenCalledTimes(3);
  });

  it('does not name-adopt a D1 when successful create output omits its immutable ID', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('Created database'));

    await expect(createD1Database('test-authrim-core-db')).rejects.toThrow(
      'returned no immutable database ID'
    );
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('does not return or recreate a successful D1 create that never becomes visible', async () => {
    const createdId = '55555555-5555-4555-8555-555555555555';
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValue(commandResult('[]'));

    await expect(createD1Database('test-authrim-core-db')).rejects.toThrow(
      'was not visible after creation (3 readback attempts)'
    );
    expect(execaMock).toHaveBeenCalledTimes(5);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(1);
  });

  it('never reissues an interrupted create_issued D1 mutation when inventory is absent', async () => {
    execaMock.mockResolvedValue(commandResult('[]'));

    await expect(
      createD1Database('test-authrim-core-db', undefined, {
        allowExisting: false,
        recordedState: 'create_issued',
      })
    ).rejects.toThrow('Setup will not reissue the create');
    expect(execaMock).toHaveBeenCalledOnce();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(0);
  });

  it('checkpoints a definite D1 4xx rejection without readback retries', async () => {
    const onCreateRejected = vi.fn();
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'HTTP status 403: forbidden', 1));

    await expect(
      createD1Database('test-authrim-core-db', undefined, { onCreateRejected })
    ).rejects.toThrow('HTTP status 403: forbidden');
    expect(onCreateRejected).toHaveBeenCalledOnce();
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('retries Cloudflare authentication code 10000 inside one D1 create attempt', async () => {
    const createdId = '66666666-6666-4666-8666-666666666666';
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', WRANGLER_AUTH_ERROR, 1))
      .mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT)
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: createdId }]))
      );

    await expect(createD1Database('test-authrim-core-db')).resolves.toEqual({
      id: createdId,
      name: 'test-authrim-core-db',
    });
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(2);
    expect(
      execaMock.mock.calls.map((call) => (call[1] as string[]).slice(0, 3).join(' '))
    ).toContain('wrangler whoami');
  });

  it('retries an explicit Cloudflare 429 as a definite non-commit create rejection', async () => {
    const createdId = '88888888-8888-4888-8888-888888888888';
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'HTTP status 429: rate limit exceeded', 1))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: createdId }]))
      );

    await expect(createD1Database('test-authrim-core-db')).resolves.toEqual({
      id: createdId,
      name: 'test-authrim-core-db',
    });
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler d1 create'
      )
    ).toHaveLength(2);
  });

  it('records exhausted authentication code 10000 as rejected and permits a later retry', async () => {
    const onCreateRejected = vi.fn();
    const authFailure = commandResult('', WRANGLER_AUTH_ERROR, 1);
    const createdId = '77777777-7777-4777-8777-777777777777';
    execaMock.mockResolvedValueOnce(commandResult('[]'));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      execaMock.mockResolvedValueOnce(authFailure);
      if (attempt === 0) execaMock.mockResolvedValueOnce(WRANGLER_WHOAMI_RESULT);
    }

    await expect(
      createD1Database('test-authrim-core-db', undefined, { onCreateRejected })
    ).rejects.toThrow('Authentication error [code: 10000]');
    expect(onCreateRejected).toHaveBeenCalledOnce();

    execaMock
      .mockReset()
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ uuid: createdId })))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ name: 'test-authrim-core-db', uuid: createdId }]))
      );

    await expect(
      createD1Database('test-authrim-core-db', undefined, {
        recordedState: 'create_rejected',
      })
    ).resolves.toEqual({ id: createdId, name: 'test-authrim-core-db' });
  });

  it('adopts an existing KV namespace without issuing another create', async () => {
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'a'.repeat(32) }]))
    );

    await expect(createKVNamespace('test-SETTINGS')).resolves.toEqual({
      id: 'a'.repeat(32),
      name: 'test-SETTINGS',
    });
    expect(execaMock).toHaveBeenCalledOnce();
    expect(execaMock.mock.calls[0]?.[1]).toEqual(['wrangler', 'kv', 'namespace', 'list']);
  });

  it('rejects a pre-existing KV namespace during a fresh provisioning attempt', async () => {
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'a'.repeat(32) }]))
    );

    await expect(
      createKVNamespace('test-SETTINGS', false, { allowExisting: false })
    ).rejects.toThrow('already exists outside this provisioning attempt');
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('authorizes adoption only for the exact resource checkpointed by this intent', () => {
    const resources = {
      'd1:DB': {
        kind: 'd1' as const,
        binding: 'DB',
        name: 'test-authrim-core-db',
        state: 'create_issued' as const,
      },
      'kv:SETTINGS': {
        kind: 'kv' as const,
        binding: 'SETTINGS',
        name: 'test-SETTINGS',
        state: 'created' as const,
        id: 'namespace-recorded',
      },
      'kv:AUTHRIM_CONFIG': {
        kind: 'kv' as const,
        binding: 'AUTHRIM_CONFIG',
        name: 'test-AUTHRIM_CONFIG',
        state: 'create_rejected' as const,
      },
      'kv:USER_CACHE': {
        kind: 'kv' as const,
        binding: 'USER_CACHE',
        name: 'test-USER_CACHE',
        state: 'identified' as const,
        id: 'identified-namespace',
      },
    };

    expect(
      getProvisioningResourceAdoptionPolicy(resources, {
        kind: 'd1',
        binding: 'DB',
        name: 'test-authrim-core-db',
      })
    ).toEqual({
      allowExisting: false,
      recordedState: 'create_issued',
      expectedExistingId: undefined,
    });
    expect(
      getProvisioningResourceAdoptionPolicy(resources, {
        kind: 'kv',
        binding: 'CONSENT_CACHE',
        name: 'test-CONSENT_CACHE',
      })
    ).toEqual({
      allowExisting: false,
      recordedState: undefined,
      expectedExistingId: undefined,
    });
    expect(
      getProvisioningResourceAdoptionPolicy(resources, {
        kind: 'kv',
        binding: 'USER_CACHE',
        name: 'test-USER_CACHE',
      })
    ).toEqual(
      expect.objectContaining({
        allowExisting: true,
        recordedState: 'identified',
        expectedExistingId: 'identified-namespace',
      })
    );
    expect(
      getProvisioningResourceAdoptionPolicy(resources, {
        kind: 'kv',
        binding: 'AUTHRIM_CONFIG',
        name: 'test-AUTHRIM_CONFIG',
      })
    ).toEqual({
      allowExisting: false,
      recordedState: 'create_rejected',
      expectedExistingId: undefined,
    });
    expect(
      getProvisioningResourceAdoptionPolicy(resources, {
        kind: 'kv',
        binding: 'SETTINGS',
        name: 'test-SETTINGS',
      })
    ).toEqual({
      allowExisting: true,
      recordedState: 'created',
      expectedExistingId: 'namespace-recorded',
    });
  });

  it('does not authorize Queue adoption from a created checkpoint without an immutable ID', () => {
    expect(() =>
      getProvisioningResourceAdoptionPolicy(
        {
          'queue:AUDIT_QUEUE': {
            kind: 'queue',
            binding: 'AUDIT_QUEUE',
            name: 'test-audit-queue',
            state: 'created',
          },
        },
        {
          kind: 'queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
        }
      )
    ).toThrow('provisioning_resource_identity_missing:queue:AUDIT_QUEUE');
  });

  it('does not authorize R2 adoption from a created checkpoint without full ownership proof', () => {
    expect(() =>
      getProvisioningResourceAdoptionPolicy(
        {
          'r2:MIGRATION_RELEASES': {
            kind: 'r2',
            binding: 'MIGRATION_RELEASES',
            name: 'test-migration-releases',
            state: 'created',
          },
        },
        {
          kind: 'r2',
          binding: 'MIGRATION_RELEASES',
          name: 'test-migration-releases',
        }
      )
    ).toThrow('provisioning_resource_identity_missing:r2:MIGRATION_RELEASES');
  });

  it('does not adopt a same-name resource after a pre-provider-call create_issued crash', async () => {
    const resource = {
      kind: 'kv' as const,
      binding: 'SETTINGS',
      name: 'test-SETTINGS',
    };
    const policy = getProvisioningResourceAdoptionPolicy(
      {
        'kv:SETTINGS': {
          ...resource,
          state: 'create_issued',
        },
      },
      resource
    );
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'foreign-id' }]))
    );

    await expect(createKVNamespace(resource.name, false, policy)).rejects.toThrow(
      'already exists outside this provisioning attempt'
    );
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('persists create-issued after absence verification and before the provider mutation', async () => {
    const events: string[] = [];
    let providerMutationCompleted = false;
    execaMock.mockImplementation(async (_command, args: string[]) => {
      if (args.slice(0, 4).join(' ') === 'wrangler kv namespace list') {
        if (providerMutationCompleted) {
          events.push('visibility_readback');
          return commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'c'.repeat(32) }]));
        }
        events.push('absence_verified');
        return commandResult('[]');
      }
      if (args.slice(0, 4).join(' ') === 'wrangler kv namespace create') {
        events.push('provider_mutation');
        providerMutationCompleted = true;
        return commandResult(JSON.stringify({ id: 'c'.repeat(32) }));
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        onCreateIssued: async () => {
          events.push('create_issued');
        },
        onProviderIdentityIdentified: async ({ id }) => {
          expect(id).toBe('c'.repeat(32));
          events.push('provider_identified');
        },
      })
    ).resolves.toEqual({ id: 'c'.repeat(32), name: 'test-SETTINGS' });
    expect(events).toEqual([
      'absence_verified',
      'create_issued',
      'provider_mutation',
      'provider_identified',
      'visibility_readback',
    ]);
  });

  it('never reissues an interrupted create_issued KV mutation when inventory is absent', async () => {
    execaMock.mockResolvedValue(commandResult('[]'));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        recordedState: 'create_issued',
      })
    ).rejects.toThrow('Setup will not reissue the create');
    expect(execaMock).toHaveBeenCalledOnce();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(0);
  });

  it('resumes an identified KV only by its immutable ID and never issues create', async () => {
    const expectedId = 'e'.repeat(32);
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: expectedId }]))
      );

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: true,
        recordedState: 'identified',
        expectedExistingId: expectedId,
      })
    ).resolves.toEqual({ id: expectedId, name: 'test-SETTINGS' });
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(0);
  });

  it('does not recreate a resource checkpointed created when provider inventory is missing', async () => {
    execaMock.mockResolvedValueOnce(commandResult('[]'));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: true,
        recordedState: 'created',
        expectedExistingId: 'namespace-recorded',
      })
    ).rejects.toThrow('recorded by provisioning is missing');
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it.each([
    '409 already exists',
    'HTTP status 409: already exists',
    'A resource with that name already exists',
    'Resource name already in use',
    'status code: 409 name conflict',
  ])('revokes adoption authority after a deterministic create race: %s', async (message) => {
    const events: string[] = [];
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', message, 1));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        onCreateIssued: async () => {
          events.push('create_issued');
        },
        onCreateRejected: async () => {
          events.push('create_rejected');
        },
      })
    ).rejects.toThrow(message);
    expect(events).toEqual(['create_issued', 'create_rejected']);
  });

  it('keeps a generic provider 409 ambiguous when it has no explicit name-collision evidence', async () => {
    const onCreateRejected = vi.fn();
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'status code: 409 resource conflict', 1))
      .mockResolvedValue(commandResult('[]'));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        onCreateRejected,
      })
    ).rejects.toThrow('returned no immutable namespace ID');

    expect(onCreateRejected).not.toHaveBeenCalled();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(1);
  });

  it('does not adopt another actor resource after an explicit name collision', async () => {
    const events: string[] = [];
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'A namespace with that name already exists', 1));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        onCreateIssued: async () => {
          events.push('create_issued');
        },
        onCreateRejected: async () => {
          events.push('create_rejected');
        },
      })
    ).rejects.toThrow('already exists');

    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'a'.repeat(32) }]))
    );
    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        recordedState: 'create_rejected',
      })
    ).rejects.toThrow('already exists outside this provisioning attempt');

    expect(events).toEqual(['create_issued', 'create_rejected']);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(1);
  });

  it('does not mistake a numeric resource name for an HTTP 5xx response', async () => {
    const events: string[] = [];
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'permission denied for test-500-SETTINGS', 1))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ title: 'test-500-SETTINGS', id: 'f'.repeat(32) }]))
      );

    await expect(
      createKVNamespace('test-500-SETTINGS', false, {
        allowExisting: false,
        onCreateIssued: async () => {
          events.push('create_issued');
        },
        onCreateRejected: async () => {
          events.push('create_rejected');
        },
      })
    ).rejects.toThrow('permission denied for test-500-SETTINGS');
    expect(events).toEqual(['create_issued', 'create_rejected']);
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('keeps generated setup tokens out of process arguments and removes the private file', async () => {
    let observedPath = '';
    let observedValue = '';
    let observedMode = 0;
    let observedArgs: string[] = [];
    execaMock.mockImplementationOnce(async (_command, args: string[]) => {
      observedArgs = [...args];
      const pathIndex = args.indexOf('--path');
      expect(pathIndex).toBeGreaterThanOrEqual(0);
      observedPath = args[pathIndex + 1]!;
      observedValue = await readFile(observedPath, 'utf-8');
      observedMode = (await stat(observedPath)).mode & 0o777;
      return commandResult();
    });

    const result = await generateAndStoreSetupToken('a'.repeat(32), 120);

    expect(result.success).toBe(true);
    expect(observedValue).toBe(result.token);
    expect(observedArgs).not.toContain(result.token);
    expect(observedMode).toBe(0o600);
    expect(existsSync(observedPath)).toBe(false);
  });

  it('adopts a KV namespace when the create response is lost after commit', async () => {
    const createdId = 'b'.repeat(32);
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', `network response lost {"id":"${createdId}"}`, 1))
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: createdId }]))
      );

    await expect(
      createKVNamespace('test-SETTINGS', false, { allowExisting: false })
    ).resolves.toEqual({
      id: createdId,
      name: 'test-SETTINGS',
    });
    expect(execaMock).toHaveBeenCalledTimes(4);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(1);
  });

  it('waits for a successful KV create to become visible with the same provider ID', async () => {
    const createdId = 'd'.repeat(32);
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ id: createdId })))
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: createdId }]))
      );

    await expect(createKVNamespace('test-SETTINGS')).resolves.toEqual({
      id: createdId,
      name: 'test-SETTINGS',
    });
    expect(execaMock).toHaveBeenCalledTimes(4);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(1);
  });

  it('fails closed when KV readback identity differs from a successful create response', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ id: 'd'.repeat(32) })))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ title: 'test-SETTINGS', id: 'e'.repeat(32) }]))
      );

    await expect(createKVNamespace('test-SETTINGS')).rejects.toThrow(
      'does not match the provider create response'
    );
    expect(execaMock).toHaveBeenCalledTimes(3);
  });

  it('does not name-adopt a KV namespace when successful output omits its immutable ID', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('Created namespace'));

    await expect(createKVNamespace('test-SETTINGS')).rejects.toThrow(
      'returned no immutable namespace ID'
    );
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('does not return or recreate a successful KV create that never becomes visible', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ id: 'f'.repeat(32) })))
      .mockResolvedValue(commandResult('[]'));

    await expect(createKVNamespace('test-SETTINGS')).rejects.toThrow(
      'was not visible after creation (3 readback attempts)'
    );
    expect(execaMock).toHaveBeenCalledTimes(5);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 4).join(' ') === 'wrangler kv namespace create'
      )
    ).toHaveLength(1);
  });

  it.each([
    'socket hang up',
    'UND_ERR_SOCKET: other side closed',
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNABORTED',
    'write EPIPE',
  ])('fails closed when a KV transport failure has no immutable ID: %s', async (transportError) => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockRejectedValueOnce(new Error(transportError));

    await expect(
      createKVNamespace('test-SETTINGS', false, { allowExisting: false })
    ).rejects.toThrow('returned no immutable namespace ID');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('leaves an ambiguous create_issued checkpoint for explicit recovery', async () => {
    const onCreateRejected = vi.fn();
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockRejectedValueOnce(new Error('UND_ERR_SOCKET: other side closed'));

    await expect(
      createKVNamespace('test-SETTINGS', false, {
        allowExisting: false,
        onCreateRejected,
      })
    ).rejects.toThrow('returned no immutable namespace ID');

    expect(onCreateRejected).not.toHaveBeenCalled();
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('preserves a real KV create failure when inventory confirms absence', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'permission denied', 1))
      .mockResolvedValueOnce(commandResult('[]'));

    await expect(createKVNamespace('test-SETTINGS')).rejects.toThrow('permission denied');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('adopts an existing Queue without issuing another create', async () => {
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue', queue_id: 'queue-1' }]))
    );

    await expect(createQueue('test-audit-queue')).resolves.toEqual({
      id: 'queue-1',
      name: 'test-audit-queue',
      providerId: 'queue-1',
    });
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('rejects a pre-existing Queue during a fresh provisioning attempt', async () => {
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue', queue_id: 'queue-1' }]))
    );

    await expect(createQueue('test-audit-queue', { allowExisting: false })).rejects.toThrow(
      'already exists outside this provisioning attempt'
    );
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('creates a Queue through the REST API and pins the returned queue_id', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    let queueExists = false;
    let createAttempts = 0;
    const fetch = vi.fn(async (_rawUrl: string | URL, init: FetchInit = {}) => {
      if (init.method === 'POST') {
        createAttempts += 1;
        if (createAttempts === 1) {
          return {
            ok: false,
            status: 403,
            headers: new Headers(),
            json: async () => ({
              success: false,
              errors: [{ code: 10_000, message: 'Authentication error' }],
            }),
          };
        }
        queueExists = true;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: { queue_name: 'test-audit-queue', queue_id: 'queue-rest-id' },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          result: queueExists
            ? [{ queue_name: 'test-audit-queue', queue_id: 'queue-rest-id' }]
            : [],
          result_info: {
            count: queueExists ? 1 : 0,
            page: 1,
            per_page: 1000,
            total_count: queueExists ? 1 : 0,
            total_pages: queueExists ? 1 : 0,
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetch);
    const onProviderIdentityIdentified = vi.fn(async () => undefined);

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: false,
        onProviderIdentityIdentified,
      })
    ).resolves.toEqual({
      id: 'queue-rest-id',
      name: 'test-audit-queue',
      providerId: 'queue-rest-id',
    });
    expect(onProviderIdentityIdentified).toHaveBeenCalledWith({ id: 'queue-rest-id' });
    expect(createAttempts).toBe(2);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('fails closed when Wrangler stderr claims a Queue ID after a lost create response', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', '503 response lost {"queue_id":"queue-2"}', 1));

    await expect(createQueue('test-audit-queue', { allowExisting: false })).rejects.toThrow(
      'returned no immutable queue ID'
    );
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('never checkpoints a generic request ID from an ambiguous Queue error', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'HTTP status 503: {"id":"request-or-ray-id"}', 1));
    const onProviderIdentityIdentified = vi.fn(async () => undefined);

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: false,
        onProviderIdentityIdentified,
      })
    ).rejects.toThrow('returned no immutable queue ID');
    expect(onProviderIdentityIdentified).not.toHaveBeenCalled();
  });

  it('fails closed when a lost Queue create response has no immutable ID', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'HTTP status 503: response lost', 1));

    await expect(createQueue('test-audit-queue', { allowExisting: false })).rejects.toThrow(
      'returned no immutable queue ID'
    );
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler queues create'
      )
    ).toHaveLength(1);
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('does not adopt another actor Queue after an explicit create-name collision', async () => {
    const events: string[] = [];
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', 'Queue name already in use', 1));

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: false,
        onCreateIssued: async () => {
          events.push('create_issued');
        },
        onCreateRejected: async () => {
          events.push('create_rejected');
        },
      })
    ).rejects.toThrow('already in use');

    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue', queue_id: 'queue-other' }]))
    );
    await expect(
      createQueue('test-audit-queue', {
        allowExisting: false,
        recordedState: 'create_rejected',
      })
    ).rejects.toThrow('already exists outside this provisioning attempt');

    expect(events).toEqual(['create_issued', 'create_rejected']);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler queues create'
      )
    ).toHaveLength(1);
  });

  it('fails Queue provisioning immediately on a deterministic provider error', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult('', '403 missing queue permission', 1))
      .mockResolvedValueOnce(commandResult('[]'));

    await expect(createQueue('test-audit-queue')).rejects.toThrow('403 missing queue permission');
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it('requires a newly created Queue to become visible before returning it', async () => {
    execaMock
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(commandResult(JSON.stringify({ id: 'queue-3' })))
      .mockResolvedValueOnce(commandResult('[]'))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([{ queue_name: 'test-audit-queue', queue_id: 'queue-3' }]))
      );

    await expect(createQueue('test-audit-queue')).resolves.toEqual({
      id: 'queue-3',
      name: 'test-audit-queue',
      providerId: 'queue-3',
    });
    expect(execaMock).toHaveBeenCalledTimes(4);
  });

  it('never reissues an interrupted create_issued Queue mutation when inventory is absent', async () => {
    execaMock.mockResolvedValue(commandResult('[]'));

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: false,
        recordedState: 'create_issued',
      })
    ).rejects.toThrow('Setup will not reissue the create');
    expect(execaMock).toHaveBeenCalledOnce();
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[]).slice(0, 3).join(' ') === 'wrangler queues create'
      )
    ).toHaveLength(0);
  });

  it('rejects a Queue whose known provider ID differs from the recorded checkpoint', async () => {
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue', queue_id: 'queue-other' }]))
    );

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: true,
        recordedState: 'created',
        expectedExistingId: 'queue-recorded',
      })
    ).rejects.toThrow('does not match the recorded provisioning resource');
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('uses REST identity proof to resume Queue provisioning when Wrangler omits IDs', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue' }]))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ queue_name: 'test-audit-queue', queue_id: 'queue-recorded' }],
            result_info: { page: 1, per_page: 1000, total_count: 1, total_pages: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: true,
        recordedState: 'created',
        expectedExistingId: 'queue-recorded',
      })
    ).resolves.toEqual({
      id: 'queue-recorded',
      name: 'test-audit-queue',
      providerId: 'queue-recorded',
    });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('rejects Queue provisioning resume when REST proves a replacement immutable ID', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue' }]))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ queue_name: 'test-audit-queue', queue_id: 'queue-replacement' }],
            result_info: { page: 1, per_page: 1000, total_count: 1, total_pages: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(
      createQueue('test-audit-queue', {
        allowExisting: true,
        recordedState: 'created',
        expectedExistingId: 'queue-recorded',
      })
    ).rejects.toThrow('does not match the recorded provisioning resource');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('uses the Cloudflare API when Wrangler Queue inventory omits immutable IDs', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue' }]))
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ queue_name: 'test-audit-queue', queue_id: 'queue-api-id' }],
          result_info: { page: 1, per_page: 1000, total_count: 1, total_pages: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listQueues({ strictOutput: true, requireIds: true })).resolves.toEqual([
      { name: 'test-audit-queue', id: 'queue-api-id' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the complete paginated API inventory even when Wrangler page one has IDs', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValue(
      commandResult(
        JSON.stringify([{ queue_name: 'page-one-queue', queue_id: 'wrangler-page-one-id' }])
      )
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const page = Number(url.searchParams.get('page'));
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            page === 1
              ? { queue_name: 'page-one-queue', queue_id: 'queue-api-1' }
              : { queue_name: 'page-two-queue', queue_id: 'queue-api-2' },
          ],
          result_info: {
            count: 1,
            page,
            per_page: 1,
            total_count: 2,
            total_pages: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listQueues({ strictOutput: true, requireIds: true })).resolves.toEqual([
      { name: 'page-one-queue', id: 'queue-api-1' },
      { name: 'page-two-queue', id: 'queue-api-2' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('fails an identity-required Queue inventory when every provider path omits IDs', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValueOnce(
      commandResult(JSON.stringify([{ queue_name: 'test-audit-queue' }]))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ queue_name: 'test-audit-queue' }],
            result_info: { page: 1, per_page: 1000, total_count: 1, total_pages: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(listQueues({ strictOutput: true, requireIds: true })).rejects.toThrow(
      'Cloudflare API Queue inventory omitted immutable Queue IDs'
    );
  });

  it('fails an identity-required Queue inventory with duplicate names or IDs', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
    process.env.CLOUDFLARE_API_TOKEN = 'api-token';
    execaMock.mockResolvedValueOnce(
      commandResult(
        JSON.stringify([
          { queue_name: 'test-audit-queue', queue_id: 'queue-wrangler-a' },
          { queue_name: 'test-audit-queue', queue_id: 'queue-wrangler-b' },
        ])
      )
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [
              { queue_name: 'test-audit-queue', queue_id: 'queue-api-shared' },
              { queue_name: 'test-other-queue', queue_id: 'queue-api-shared' },
            ],
            result_info: { page: 1, per_page: 1000, total_count: 2, total_pages: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(listQueues({ strictOutput: true, requireIds: true })).rejects.toThrow(
      'Cloudflare API Queue inventory contained a duplicate immutable Queue ID'
    );
  });
});
