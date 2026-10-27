import { describe, expect, it, vi } from 'vitest';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type { StoreCodeRequest } from '@authrim/ar-lib-core/durable-objects/AuthorizationCodeStore';
import { createAwsStateStores } from '../create-state-stores';
import { createDynamoStateClient, DynamoStateTable } from '../dynamodb-state';

function fixture(respond: (command: unknown) => Promise<unknown> = async () => ({}), now = 1000) {
  const client = createDynamoStateClient({
    region: 'ap-northeast-1',
    credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
  });
  const send = vi.spyOn(client, 'send').mockImplementation(respond as never);
  const options = {
    client,
    tableName: 'test-state',
    namespace: 'generation-one',
    now: () => now,
  };
  return {
    ...createAwsStateStores({ backend: 'dynamodb', ...options }),
    table: new DynamoStateTable(options),
    send,
  };
}
function failure(name: string): Error {
  return Object.assign(new Error('opaque service error'), { name });
}
const challenge = {
  tenantId: 'tenant-a',
  id: 'challenge-id',
  type: 'passkey',
  userId: 'user-a',
  challenge: 'bearer-secret',
  ttlMs: 999,
};
const code = {
  code: '00000000-0000-4000-8000-000000000000',
  tenantId: 'tenant-a',
  userId: 'user-a',
  clientId: 'direct-auth',
  redirectUri: 'https://authrim.local/direct-auth/callback',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  scope: 'openid',
} satisfies StoreCodeRequest;

describe('DynamoDB state boundary', () => {
  it('requires an explicit valid table and restore namespace', () => {
    const options = {
      client: {} as DynamoDBClient,
      tableName: 'test-state',
      namespace: 'generation-one',
    };
    expect(() => new DynamoStateTable({ ...options, namespace: '' })).toThrow(
      'aws_state_configuration_invalid'
    );
    expect(() => new DynamoStateTable({ ...options, tableName: 'arn:aws:unexpected' })).toThrow(
      'aws_state_configuration_invalid'
    );
    expect(() => createAwsStateStores({ backend: 'unknown' } as never)).toThrow(
      'aws_state_backend_unsupported'
    );
  });
  it('isolates namespace, tenant, kind and ambiguous identities without raw user keys', () => {
    const { table } = fixture();
    const keys = [
      table.key('tenant-a', 'SESSION', 'sensitive/user@example.test'),
      table.key('tenant-b', 'SESSION', 'sensitive/user@example.test'),
      table.key('tenant-a', 'CHALLENGE', 'sensitive/user@example.test'),
    ];
    expect(new Set(keys.map((k) => k.pk.S)).size).toBe(3);
    expect(JSON.stringify(keys)).not.toContain('user@example.test');
    const other = new DynamoStateTable({
      client: createDynamoStateClient({ region: 'ap-northeast-1' }),
      tableName: 'test-state',
      namespace: 'generation-two',
    });
    expect(other.key('tenant-a', 'SESSION', 'sensitive/user@example.test')).not.toEqual(keys[0]);
  });
  it('validates malformed and unsupported requests before calling storage', async () => {
    const f = fixture();
    await expect(
      f.state.storeChallenge({ ...challenge, tenantId: 'wrong tenant' })
    ).rejects.toThrow();
    await expect(
      f.state.storeChallenge({ ...challenge, challenge: 'bad\nvalue' })
    ).rejects.toThrow();
    await expect(f.state.storeChallenge({ ...challenge, ttlMs: 0 })).rejects.toThrow();
    await expect(
      f.state.isChallengeClaimHeld({ ...challenge, minRemainingMs: -1 })
    ).rejects.toThrow();
    await expect(
      f.accountAuthentication.getAccountStateRpc('tenant-a', 'user-a', 'account:wrong')
    ).rejects.toThrow();
    await expect(
      f.authorizationCodes.store({ ...code, redirectUri: 'https://external.test' })
    ).rejects.toThrow('aws_authorization_code_profile_unsupported');
    await expect(
      f.rateLimit.check({ key: 'key', windowSeconds: 0, maxRequests: 1 })
    ).rejects.toThrow();
    await expect(
      f.persistentNameIDs.get({
        tenantId: 'tenant-b',
        key: 'saml:persistent-nameid:tenant:tenant-a:sp:sp:subject:subject',
      })
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('uses explicit milliseconds for expiry and integer seconds only for cleanup', async () => {
    const f = fixture();
    expect(await f.state.storeChallenge(challenge)).toBe(true);
    const command = f.send.mock.calls[0][0] as PutItemCommand;
    expect(command.input.Item?.expiresAtMs).toEqual({ N: '1999' });
    expect(command.input.Item?.ttl).toEqual({ N: '2' });
    expect(command.input.ConditionExpression).toContain('expiresAtMs <= :now');
    expect(await f.state.storeChallenge({ ...challenge, notAfterMs: 1000 })).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('reads security state consistently and rejects expired rows while TTL cleanup is pending', async () => {
    const f = fixture(async () => ({
      Item: { expiresAtMs: { N: '1000' }, payloadJson: { S: '{"value":"secret"}' } },
    }));
    expect(await f.state.getKey({ tenantId: 'tenant-a', key: 'key' })).toBeNull();
    expect((f.send.mock.calls[0][0] as GetItemCommand).input.ConsistentRead).toBe(true);
  });
  it('does not treat a failed conditional consume as a successful read', async () => {
    const f = fixture(async () => {
      throw failure('ConditionalCheckFailedException');
    });
    expect(await f.state.consumeChallenge(challenge)).toBeNull();
    const command = f.send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input.ReturnValues).toBe('ALL_OLD');
    expect(command.input.ConditionExpression).toContain('attribute_exists(pk)');
    expect(command.input.ConditionExpression).toContain('expiresAtMs > :now');
    expect(command.input.ConditionExpression).toContain('challengeHash = :hash');
    expect(JSON.stringify(command.input.ExpressionAttributeValues)).not.toContain(
      challenge.challenge
    );
    expect(await f.state.storeChallenge(challenge)).toBe(false);
  });
  it('fails closed on unavailable storage and a consume without a receipt', async () => {
    const down = fixture(async () => {
      throw failure('AccessDeniedException');
    });
    await expect(down.state.consumeChallenge(challenge)).rejects.toThrow('opaque service error');
    const absent = fixture();
    await expect(absent.state.consumeChallenge(challenge)).rejects.toThrow(
      'aws_state_consume_receipt_missing'
    );
  });
  it('does not make a missing account active', async () => {
    const f = fixture();
    expect(
      await f.accountAuthentication.getAccountStateRpc('tenant-a', 'user-a', 'account:user-a')
    ).toEqual({
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    });
    await expect(
      f.state.createSession({
        tenantId: 'tenant-a',
        userId: 'user-a',
        sessionId: 'session',
        ttlMs: 1000,
      })
    ).rejects.toThrow('Session unavailable');
    expect(f.send.mock.calls.every(([command]) => command instanceof GetItemCommand)).toBe(true);
  });
  it('does not apply TTL to persistent NameIDs and hashes semantic records independently of createdAt/order', async () => {
    const f = fixture();
    const key = 'saml:persistent-nameid:tenant:tenant-a:sp:sp:subject:subject';
    const record = {
      version: 1,
      tenantId: 'tenant-a',
      spEntityId: 'sp',
      subjectId: 'subject',
      nameId: 'stable',
      createdAt: 1000,
    };
    await f.persistentNameIDs.put({ tenantId: 'tenant-a', key, value: JSON.stringify(record) });
    await f.persistentNameIDs.put({
      tenantId: 'tenant-a',
      key,
      value: JSON.stringify({
        createdAt: 2000,
        nameId: 'stable',
        subjectId: 'subject',
        spEntityId: 'sp',
        tenantId: 'tenant-a',
        version: 1,
      }),
    });
    const commands = f.send.mock.calls.map(([command]) => command as UpdateItemCommand);
    expect(commands[0].input.ExpressionAttributeValues?.[':hash']).toEqual(
      commands[1].input.ExpressionAttributeValues?.[':hash']
    );
    expect(commands[0].input.UpdateExpression).toContain('if_not_exists(valueJson, :value)');
    expect(commands[0].input.UpdateExpression).not.toContain('ttl');
  });
});

it.each(['saml', 'kv'] as const)(
  'does not reopen consumed %s state by retrying a lost successful response',
  async (kind) => {
    let attempts = 0;
    let consumed = true;
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
      requestHandler: {
        handle: async () => {
          attempts++;
          // Commit the store; another invocation consumes it before the response is lost.
          consumed = false;
          if (attempts === 1) consumed = true;
          throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' });
        },
      },
    });
    const stores = createAwsStateStores({
      backend: 'dynamodb',
      client,
      tableName: 'test-state',
      namespace: 'generation-one',
      now: () => 1000,
    });
    const operation =
      kind === 'kv'
        ? stores.state.putKey({
            tenantId: 'tenant-a',
            key: 'continuation',
            value: 'data',
            ttlMs: 1000,
          })
        : stores.state.storeSamlRequest({
            tenantId: 'tenant-a',
            spEntityId: 'https://sp.example.test',
            request: {
              requestId: 'request',
              issuer: 'https://sp.example.test',
              destination: 'https://idp.example.test',
              type: 'authn_request',
              expiresAt: 2000,
            } as never,
          });
    await expect(operation).rejects.toThrow('lost response');
    expect(attempts).toBe(1);
    expect(consumed).toBe(true);
    client.destroy();
  }
);

it('rejects SDK clients whose automatic retry behavior is not constrained by the state factory', () => {
  expect(
    () =>
      new DynamoStateTable({
        client: {} as DynamoDBClient,
        tableName: 'test-state',
        namespace: 'generation-one',
      })
  ).toThrow('aws_state_single_attempt_client_required');
});

it('fails closed when a consume commits but the response arrives after expiry', async () => {
  let now = 1000;
  const client = createDynamoStateClient({ region: 'ap-northeast-1' });
  vi.spyOn(client, 'send').mockImplementation((async () => {
    now = 2000;
    return { Attributes: { expiresAtMs: { N: '1500' } } };
  }) as never);
  const stores = createAwsStateStores({
    backend: 'dynamodb',
    client,
    tableName: 'test-state',
    namespace: 'generation-one',
    now: () => now,
  });
  expect(await stores.state.consumeChallenge(challenge)).toBeNull();
});

it.each([undefined, 'http://127.0.0.1:58000'])(
  'ignores inherited endpoint overrides while preserving explicit loopback %s',
  async (endpoint) => {
    const prior = process.env.AWS_ENDPOINT_URL_DYNAMODB;
    process.env.AWS_ENDPOINT_URL_DYNAMODB = 'https://unexpected-endpoint.example.test';
    let hostname: string | undefined;
    const client = createDynamoStateClient({
      region: 'ap-northeast-1',
      endpoint,
      credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
      requestHandler: {
        handle: async (request: { hostname?: string }) => {
          hostname = request.hostname;
          throw new Error('test transport stopped');
        },
      },
    });
    try {
      const stores = createAwsStateStores({
        backend: 'dynamodb',
        client,
        tableName: 'test-state',
        namespace: 'generation-one',
      });
      await expect(
        stores.state.putKey({ tenantId: 'tenant-a', key: 'key', value: 'value', ttlMs: 1000 })
      ).rejects.toThrow('test transport stopped');
      expect(hostname).toBe(endpoint ? '127.0.0.1' : 'dynamodb.ap-northeast-1.amazonaws.com');
    } finally {
      client.destroy();
      if (prior === undefined) delete process.env.AWS_ENDPOINT_URL_DYNAMODB;
      else process.env.AWS_ENDPOINT_URL_DYNAMODB = prior;
    }
  }
);
