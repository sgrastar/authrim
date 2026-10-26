/** Regional DynamoDB implementations of the existing AWS authentication state ports. */
import { createHash, randomUUID } from 'node:crypto';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import type {
  AccountAuthenticationLifecycle,
  AccountAuthenticationSnapshot,
  SAMLRequestData,
} from '@authrim/ar-lib-core';
import type { StoreCodeRequest } from '@authrim/ar-lib-core/durable-objects/AuthorizationCodeStore';
import type {
  AccountAuthStateStore,
  AuthorizationCodeStore,
  CheckRateLimitInput,
  ConsumeChallengeInput,
  ConsumeSamlRequestInput,
  PersistentNameIDStore,
  PutTransientKeyInput,
  RateLimitStore,
  StoreChallengeInput,
  StoreSamlRequestInput,
  StoreSessionInput,
  TransientChallenge,
  TransientSession,
  TransientStateStore,
} from './state-ports';
import {
  persistentNameIDIdentity,
  validateSAMLPersistentNameIDRecord,
} from './persistent-nameid-record';

const stateClients = new WeakSet<object>();

/** Mutation retries may reopen consumed continuation state; use one SDK HTTP attempt. */
export function createDynamoStateClient(options: {
  region: string;
  credentials?: DynamoDBClientConfig['credentials'];
  endpoint?: string;
  requestHandler?: DynamoDBClientConfig['requestHandler'];
}): DynamoDBClient {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(options.region))
    throw new Error('aws_state_configuration_invalid');
  if (options.endpoint !== undefined) {
    const endpoint = new URL(options.endpoint);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
      throw new Error('aws_state_endpoint_invalid');
  }
  const client = new DynamoDBClient({
    ...options,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  // Retry only a transport-failed GetItem once. Writes retain one HTTP attempt.
  client.middlewareStack.add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        const failure = error as Error & {
          code?: unknown;
          $metadata?: { httpStatusCode?: unknown };
          $response?: unknown;
        };
        if (
          context.commandName !== 'GetItemCommand' ||
          !(error instanceof Error) ||
          error.name === 'AbortError' ||
          (failure.code !== 'EPIPE' && failure.code !== 'ECONNRESET') ||
          typeof failure.$metadata?.httpStatusCode === 'number' ||
          failure.$response !== undefined
        )
          throw error;
        // Re-enter serialization/signing with the same input and AbortSignal. The
        // second error is final; never replay this command a third time.
        return next(args);
      }
    },
    { step: 'initialize', name: 'authrimDynamoGetTransportRetry' }
  );
  stateClients.add(client);
  return client;
}

export interface DynamoStateOptions {
  client: Pick<DynamoDBClient, 'send'>;
  tableName: string;
  /** A pinned restore generation. Changing it selects another, isolated dataset. */
  namespace: string;
  /** Lambda wall clock; TTL deletion is never the authorization clock. */
  now?: () => number;
}

type Item = Record<string, AttributeValue>;
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const TENANT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const LIFECYCLES = new Set(['active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive']);
const MAX_ATTEMPTS = 32;

function identifier(value: string, name = 'identifier', max = 1024): void {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`Invalid ${name}`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw new Error(`Invalid ${name}`);
  }
}
function integer(value: number, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
}
function ttl(value: number): void {
  integer(value, 'transient state TTL', 1, 30 * 24 * 60 * 60 * 1000);
}
function text(item: Item, key: string): string {
  const value = item[key]?.S;
  if (value === undefined) throw new Error('aws_state_record_invalid');
  return value;
}
function number(item: Item, key: string): number {
  const raw = item[key]?.N;
  const value = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('aws_state_record_invalid');
  }
  return value;
}
function json(value: unknown, max = 64 * 1024): string {
  const result = JSON.stringify(value);
  if (!result || new TextEncoder().encode(result).byteLength > max)
    throw new Error('aws_state_payload_too_large');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('aws_state_record_invalid');
  }
  return value as Record<string, unknown>;
}
/** JSONB-style object equality: object key order is irrelevant; array order is not. */
export function canonicalDynamoStateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDynamoStateJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDynamoStateJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function payload(item: Item): Record<string, unknown> {
  return object(JSON.parse(text(item, 'payloadJson')));
}
function conditional(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
function transactionConditional(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] })
    .CancellationReasons;
  return (
    !!reasons?.some(
      (r) => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict'
    ) &&
    reasons.every(
      (r) => !r.Code || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code)
    )
  );
}
function accountIdentity(tenantId: string, userId: string, accountId: string): void {
  if (
    !TENANT.test(tenantId) ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u.test(userId) ||
    accountId !== `account:${userId}`
  ) {
    throw new Error('session_revocation_identity_invalid');
  }
}
function snapshot(item: Item | undefined): AccountAuthenticationSnapshot {
  if (!item)
    return {
      lifecycle: null,
      lifecycleVersionMs: null,
      lifecycleOperationId: null,
      revokedAfterMs: null,
      lastLoginAtMs: null,
    };
  const lifecycle = text(item, 'lifecycle');
  if (!LIFECYCLES.has(lifecycle)) throw new Error('aws_state_record_invalid');
  return {
    lifecycle: lifecycle as AccountAuthenticationLifecycle,
    lifecycleVersionMs: number(item, 'lifecycleVersionMs'),
    lifecycleOperationId: item.lifecycleOperationId ? text(item, 'lifecycleOperationId') : null,
    revokedAfterMs: item.revokedAfterMs ? number(item, 'revokedAfterMs') : null,
    lastLoginAtMs: item.lastLoginAtMs ? number(item, 'lastLoginAtMs') : null,
  };
}

/** Table schema: pk (HASH), sk (RANGE); optional ttl epoch-seconds cleanup attribute. */
export class DynamoStateTable {
  readonly client: DynamoStateOptions['client'];
  readonly tableName: string;
  readonly namespace: string;
  private readonly clock: () => number;
  constructor(options: DynamoStateOptions) {
    if (
      !/^[a-zA-Z0-9_.-]{3,255}$/u.test(options.tableName) ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(options.namespace)
    ) {
      throw new Error('aws_state_configuration_invalid');
    }
    if (!stateClients.has(options.client))
      throw new Error('aws_state_single_attempt_client_required');
    this.client = options.client;
    this.tableName = options.tableName;
    this.namespace = options.namespace;
    this.clock = options.now ?? Date.now;
  }
  now(): number {
    const value = this.clock();
    integer(value, 'state clock');
    return value;
  }
  key(tenantId: string, kind: string, identity: string, sort = 'STATE'): Item {
    if (!TENANT.test(tenantId)) throw new Error('Invalid tenant ID');
    // Tenant IDs are hashed too so arbitrarily long valid IDs cannot exceed key limits.
    return {
      pk: S(`${this.namespace}#T#${hash(tenantId)}#${kind}#${hash(identity)}`),
      sk: S(sort),
    };
  }
  accountKey(tenantId: string, userId: string): Item {
    return this.key(tenantId, 'ACCOUNT', userId);
  }
  async get(key: Item): Promise<Item | undefined> {
    const result = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })
    );
    return result.Item;
  }
  live(item: Item | undefined, now = this.now()): item is Item {
    return !!item && !item.consumedAtMs && number(item, 'expiresAtMs') > now;
  }
  transient(key: Item, value: unknown, created: number, expires: number): Item {
    integer(expires, 'state expiry');
    return {
      ...key,
      payloadJson: S(json(value)),
      createdAtMs: N(created),
      expiresAtMs: N(expires),
      ttl: N(Math.ceil(expires / 1000)),
    };
  }
  async consume(
    key: Item,
    extraCondition = '',
    extra: Item = {},
    requireLive = true
  ): Promise<Item | null> {
    const now = this.now();
    try {
      const result = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: 'SET consumedAtMs = :now',
          ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(consumedAtMs)${requireLive ? ' AND expiresAtMs > :now' : ''}${extraCondition}`,
          ExpressionAttributeValues: { ':now': N(now), ...extra },
          ReturnValues: 'ALL_OLD',
        })
      );
      if (!result.Attributes) throw new Error('aws_state_consume_receipt_missing');
      // DynamoDB compares the supplied clock value. A delayed response must not
      // authorize a request that has expired while the write was in flight.
      if (requireLive && !this.live(result.Attributes)) return null;
      return result.Attributes;
    } catch (error) {
      if (conditional(error)) return null;
      throw error;
    }
  }
}

export class DynamoAccountAuthStateStore implements AccountAuthStateStore {
  constructor(private readonly table: DynamoStateTable) {}
  async getAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    accountIdentity(tenantId, userId, accountId);
    return snapshot(await this.table.get(this.table.accountKey(tenantId, userId)));
  }
  async initializeAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number
  ): Promise<AccountAuthenticationSnapshot> {
    accountIdentity(tenantId, userId, accountId);
    if (!LIFECYCLES.has(lifecycle)) throw new Error('account_authentication_lifecycle_invalid');
    integer(sourceVersionMs, 'account auth state timestamp');
    const key = this.table.accountKey(tenantId, userId);
    try {
      await this.table.client.send(
        new PutItemCommand({
          TableName: this.table.tableName,
          Item: {
            ...key,
            lifecycle: S(lifecycle),
            lifecycleVersionMs: N(sourceVersionMs),
            revision: S(randomUUID()),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        })
      );
    } catch (error) {
      if (!conditional(error)) throw error;
    }
    // A concurrent lifecycle change must be visible; initialization never reactivates an account.
    const result = await this.table.get(key);
    if (!result) throw new Error('account_auth_state_uninitialized');
    return snapshot(result);
  }
  async advancePasskeyCounterRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    credentialId: string,
    sourceCounter: number,
    newCounter: number,
    observedAtMs: number
  ): Promise<{ counter: number; advanced: boolean }> {
    accountIdentity(tenantId, userId, accountId);
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/u.test(credentialId))
      throw new Error('account_authentication_credential_id_invalid');
    integer(sourceCounter, 'passkey counter', 0);
    integer(newCounter, 'passkey counter', 0);
    integer(observedAtMs, 'passkey counter timestamp');
    if (!(sourceCounter === 0 && newCounter === 0) && newCounter <= sourceCounter)
      throw new Error('passkey_counter_replay');
    const key = {
      ...this.table.accountKey(tenantId, userId),
      sk: S(`COUNTER#${hash(credentialId)}`),
    };
    try {
      await this.table.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.table.tableName,
                Key: this.table.accountKey(tenantId, userId),
                ConditionExpression: 'lifecycle = :active',
                ExpressionAttributeValues: { ':active': S('active') },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: key,
                UpdateExpression: 'SET #counter = :new, updatedAtMs = :at',
                ConditionExpression:
                  newCounter === 0
                    ? 'attribute_not_exists(#counter) OR #counter = :new'
                    : 'attribute_not_exists(#counter) OR #counter < :new',
                ExpressionAttributeNames: { '#counter': 'counter' },
                ExpressionAttributeValues: { ':new': N(newCounter), ':at': N(observedAtMs) },
              },
            },
          ],
        })
      );
      return { counter: newCounter, advanced: newCounter !== 0 };
    } catch (error) {
      if (!transactionConditional(error)) throw error;
      const account = await this.getAccountStateRpc(tenantId, userId, accountId);
      if (!account.lifecycle) throw new Error('account_auth_state_uninitialized');
      if (account.lifecycle !== 'active') throw new Error('account_authentication_not_allowed');
      throw new Error('passkey_counter_replay');
    }
  }
}

export class DynamoTransientStateStore implements TransientStateStore {
  constructor(private readonly table: DynamoStateTable) {}
  private key(tenant: string, kind: string, id: string, max = 1024): Item {
    identifier(id, `${kind} ID`, max);
    return this.table.key(tenant, kind, id);
  }
  async createSession(input: StoreSessionInput): Promise<TransientSession> {
    identifier(input.userId, 'user ID');
    ttl(input.ttlMs);
    const key = this.key(input.tenantId, 'SESSION', input.sessionId);
    const accountKey = this.table.accountKey(input.tenantId, input.userId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const account = await this.table.get(accountKey);
      if (!account || snapshot(account).lifecycle !== 'active')
        throw new Error('Session unavailable or ID already exists');
      const now = this.table.now();
      const revocationBoundAtMs = Math.max(now, (snapshot(account).revokedAfterMs ?? 0) + 1);
      const item = {
        ...this.table.transient(
          key,
          { userId: input.userId, ...(input.data ? { data: input.data } : {}) },
          now,
          now + input.ttlMs
        ),
        revocationBoundAtMs: N(revocationBoundAtMs),
      };
      try {
        await this.table.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.table.tableName,
                  Key: accountKey,
                  ConditionExpression: 'lifecycle = :active AND revision = :revision',
                  ExpressionAttributeValues: {
                    ':active': S('active'),
                    ':revision': S(text(account, 'revision')),
                  },
                },
              },
              {
                Put: {
                  TableName: this.table.tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          })
        );
        return this.session(item, input.tenantId, input.sessionId);
      } catch (error) {
        if (!transactionConditional(error)) throw error;
        if (await this.table.get(key)) throw new Error('Session unavailable or ID already exists');
      }
    }
    throw new Error('aws_state_contention');
  }
  private session(item: Item, tenantId: string, sessionId: string): TransientSession {
    const value = payload(item);
    if (typeof value.userId !== 'string' || !value.userId)
      throw new Error('Session storage binding invalid');
    return {
      tenantId,
      sessionId,
      userId: value.userId,
      createdAt: number(item, 'createdAtMs'),
      expiresAt: number(item, 'expiresAtMs'),
      revocationBoundAtMs: number(item, 'revocationBoundAtMs'),
      ...(value.data === undefined ? {} : { data: object(value.data) }),
    };
  }
  async getSession(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<TransientSession | null> {
    const key = this.key(input.tenantId, 'SESSION', input.sessionId);
    const found = await this.table.get(key);
    if (!this.table.live(found)) return null;
    const initial = this.session(found, input.tenantId, input.sessionId);
    // Read both items in a single serializable snapshot after discovering the account key.
    const result = await this.table.client.send(
      new TransactGetItemsCommand({
        TransactItems: [
          { Get: { TableName: this.table.tableName, Key: key } },
          {
            Get: {
              TableName: this.table.tableName,
              Key: this.table.accountKey(input.tenantId, initial.userId),
            },
          },
        ],
      })
    );
    const item = result.Responses?.[0]?.Item;
    const account = snapshot(result.Responses?.[1]?.Item);
    if (!this.table.live(item) || account.lifecycle !== 'active') return null;
    const session = this.session(item, input.tenantId, input.sessionId);
    if (
      session.userId !== initial.userId ||
      session.revocationBoundAtMs <= (account.revokedAfterMs ?? 0)
    )
      return null;
    return session;
  }
  async deleteSession(input: { tenantId: string; sessionId: string }): Promise<boolean> {
    return !!(await this.table.consume(
      this.key(input.tenantId, 'SESSION', input.sessionId),
      '',
      {},
      false
    ));
  }
  async storeChallenge(input: StoreChallengeInput): Promise<boolean> {
    const key = this.key(input.tenantId, 'CHALLENGE', input.id);
    identifier(input.type, 'challenge type', 128);
    identifier(input.userId, 'user ID');
    identifier(input.challenge, 'challenge value', 4096);
    ttl(input.ttlMs);
    if (input.notAfterMs !== undefined) integer(input.notAfterMs, 'challenge deadline');
    const now = this.table.now();
    const expires = Math.min(now + input.ttlMs, input.notAfterMs ?? Infinity);
    if (expires <= now) return false;
    const item = {
      ...this.table.transient(
        key,
        {
          type: input.type,
          userId: input.userId,
          challenge: input.challenge,
          ...(input.email ? { email: input.email } : {}),
          ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        now,
        expires
      ),
      itemId: S(input.id),
      challengeType: S(input.type),
      challengeHash: S(hash(input.challenge)),
    };
    try {
      await this.table.client.send(
        new PutItemCommand({
          TableName: this.table.tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(pk) OR attribute_exists(consumedAtMs) OR expiresAtMs <= :now',
          ExpressionAttributeValues: { ':now': N(now) },
        })
      );
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }
  claimChallenge(input: StoreChallengeInput): Promise<boolean> {
    return this.storeChallenge(input);
  }
  private challenge(item: Item, tenantId: string, id: string): TransientChallenge {
    const p = payload(item);
    if (
      typeof p.type !== 'string' ||
      typeof p.userId !== 'string' ||
      typeof p.challenge !== 'string' ||
      text(item, 'itemId') !== id ||
      p.type !== text(item, 'challengeType') ||
      hash(p.challenge) !== text(item, 'challengeHash')
    )
      throw new Error('Challenge storage binding invalid');
    return {
      tenantId,
      id,
      type: p.type,
      userId: p.userId,
      challenge: p.challenge,
      createdAt: number(item, 'createdAtMs'),
      expiresAt: number(item, 'expiresAtMs'),
      ...(typeof p.email === 'string' ? { email: p.email } : {}),
      ...(typeof p.redirectUri === 'string' ? { redirectUri: p.redirectUri } : {}),
      ...(p.metadata === undefined ? {} : { metadata: object(p.metadata) }),
    };
  }
  async consumeChallenge(input: ConsumeChallengeInput): Promise<TransientChallenge | null> {
    identifier(input.type, 'challenge type', 128);
    if (input.challenge !== undefined) identifier(input.challenge, 'challenge value', 4096);
    const item = await this.table.consume(
      this.key(input.tenantId, 'CHALLENGE', input.id),
      ` AND challengeType = :type${input.challenge === undefined ? '' : ' AND challengeHash = :hash'}`,
      {
        ':type': S(input.type),
        ...(input.challenge === undefined ? {} : { ':hash': S(hash(input.challenge)) }),
      }
    );
    return item ? this.challenge(item, input.tenantId, input.id) : null;
  }
  async getChallenge(input: { tenantId: string; id: string }): Promise<TransientChallenge | null> {
    const item = await this.table.get(this.key(input.tenantId, 'CHALLENGE', input.id));
    return this.table.live(item) ? this.challenge(item, input.tenantId, input.id) : null;
  }
  async isChallengeClaimHeld(input: {
    tenantId: string;
    id: string;
    challenge: string;
    minRemainingMs: number;
  }): Promise<boolean> {
    identifier(input.challenge, 'challenge value', 4096);
    integer(input.minRemainingMs, 'minimum remaining lifetime', 0);
    const row = await this.getChallenge(input);
    const now = this.table.now();
    return (
      !!row &&
      row.challenge === input.challenge &&
      row.expiresAt > now &&
      row.expiresAt - now >= input.minRemainingMs
    );
  }
  async deleteChallenge(input: { tenantId: string; id: string }): Promise<boolean> {
    return !!(await this.table.consume(
      this.key(input.tenantId, 'CHALLENGE', input.id),
      '',
      {},
      false
    ));
  }
  async storeSamlRequest(input: StoreSamlRequestInput): Promise<void> {
    identifier(input.spEntityId, 'SP entity ID', 4096);
    const key = this.key(input.tenantId, 'SAML', input.request.requestId);
    const request = input.request;
    if (request.type !== 'authn_request' || request.issuer !== input.spEntityId)
      throw new Error('Invalid SAML request binding');
    integer(request.expiresAt, 'SAML request expiry');
    const now = this.table.now();
    if (request.expiresAt <= now || request.expiresAt > now + 30 * 60 * 1000)
      throw new Error('SAML request expired or binding conflict');
    const immutable = hash(
      canonicalDynamoStateJson(
        JSON.parse(
          json({
            requestId: request.requestId,
            issuer: request.issuer,
            destination: request.destination,
            acsUrl: request.acsUrl ?? null,
            binding: request.binding,
            type: request.type,
            relayState: request.relayState ?? null,
            data: request.data ?? null,
          })
        )
      )
    );
    try {
      // Trusted continuation only: retain original deadline and identity, reset the current claim.
      await this.table.client.send(
        new UpdateItemCommand({
          TableName: this.table.tableName,
          Key: key,
          UpdateExpression:
            'SET payloadJson = :payload, immutableHash = :immutable, spHash = :sp, createdAtMs = if_not_exists(createdAtMs, :now), expiresAtMs = if_not_exists(expiresAtMs, :expires), #ttl = if_not_exists(#ttl, :ttl) REMOVE consumedAtMs',
          ConditionExpression:
            'attribute_not_exists(pk) OR (immutableHash = :immutable AND spHash = :sp AND expiresAtMs > :now)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':payload': S(json({ spEntityId: input.spEntityId, request })),
            ':immutable': S(immutable),
            ':sp': S(hash(input.spEntityId)),
            ':now': N(now),
            ':expires': N(request.expiresAt),
            ':ttl': N(Math.ceil(request.expiresAt / 1000)),
          },
        })
      );
    } catch (error) {
      if (conditional(error)) throw new Error('SAML request expired or binding conflict');
      throw error;
    }
  }
  async consumeSamlRequest(input: ConsumeSamlRequestInput): Promise<SAMLRequestData | null> {
    identifier(input.spEntityId, 'SP entity ID', 4096);
    const item = await this.table.consume(
      this.key(input.tenantId, 'SAML', input.requestId),
      ' AND spHash = :sp',
      { ':sp': S(hash(input.spEntityId)) }
    );
    if (!item) return null;
    const p = payload(item);
    const request = object(p.request);
    if (
      p.spEntityId !== input.spEntityId ||
      request.requestId !== input.requestId ||
      request.issuer !== input.spEntityId ||
      request.type !== 'authn_request'
    )
      throw new Error('SAML request storage binding invalid');
    return {
      ...request,
      createdAt: number(item, 'createdAtMs'),
      expiresAt: number(item, 'expiresAtMs'),
      used: true,
    } as unknown as SAMLRequestData;
  }
  async putKey(input: PutTransientKeyInput): Promise<void> {
    ttl(input.ttlMs);
    const key = this.key(input.tenantId, 'KV', input.key, 4096);
    const now = this.table.now();
    await this.table.client.send(
      new PutItemCommand({
        TableName: this.table.tableName,
        Item: this.table.transient(key, { value: input.value }, now, now + input.ttlMs),
      })
    );
  }
  async getKey(input: { tenantId: string; key: string }): Promise<string | null> {
    const item = await this.table.get(this.key(input.tenantId, 'KV', input.key, 4096));
    if (!this.table.live(item)) return null;
    const p = payload(item);
    if (typeof p.value !== 'string') throw new Error('Transient key payload invalid');
    return p.value;
  }
  async deleteKey(input: { tenantId: string; key: string }): Promise<boolean> {
    return !!(await this.table.consume(
      this.key(input.tenantId, 'KV', input.key, 4096),
      '',
      {},
      false
    ));
  }
}

export class DynamoRateLimitStore implements RateLimitStore {
  constructor(private readonly table: DynamoStateTable) {}
  async check(
    input: CheckRateLimitInput
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    if (input.tenantId !== undefined && !TENANT.test(input.tenantId))
      throw new Error('Invalid rate limit tenant');
    if (!input.key || input.key.length > 4096) throw new Error('Invalid rate limit key');
    integer(input.windowSeconds, 'rate limit window', 1, 86400);
    integer(input.maxRequests, 'rate limit maximum', 1, 1000000);
    const key =
      input.tenantId === undefined
        ? { pk: S(`${this.table.namespace}#GLOBAL#RATE#${hash(input.key)}`), sk: S('STATE') }
        : this.table.key(input.tenantId, 'RATE', input.key);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.table.get(key);
      const now = Math.floor(this.table.now() / 1000);
      const reset = !current || number(current, 'resetAt') <= now;
      const count = reset
        ? 1
        : Math.min(number(current, 'requestCount') + 1, input.maxRequests + 1);
      const resetAt = reset ? now + input.windowSeconds : number(current, 'resetAt');
      try {
        await this.table.client.send(
          new PutItemCommand({
            TableName: this.table.tableName,
            Item: {
              ...key,
              requestCount: N(count),
              resetAt: N(resetAt),
              ttl: N(resetAt),
              revision: S(randomUUID()),
            },
            ConditionExpression: current ? 'revision = :old' : 'attribute_not_exists(pk)',
            ...(current
              ? { ExpressionAttributeValues: { ':old': S(text(current, 'revision')) } }
              : {}),
          })
        );
        return {
          allowed: count <= input.maxRequests,
          remaining: Math.max(0, input.maxRequests - count),
          resetAt,
        };
      } catch (error) {
        if (!conditional(error)) throw error;
      }
    }
    throw new Error('aws_state_contention');
  }
}

export class DynamoAuthorizationCodeStore implements AuthorizationCodeStore {
  constructor(private readonly table: DynamoStateTable) {}
  async store(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }> {
    const positiveOr = (value: number | undefined, fallback: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
    const ttlSeconds = positiveOr(request.ttlSeconds, 60);
    const maximum = positiveOr(request.maxCodesPerUser, 100);
    if (
      !TENANT.test(request.tenantId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        request.code
      ) ||
      !request.userId ||
      request.userId.length > 256 ||
      !request.clientId ||
      request.clientId.length > 256 ||
      request.redirectUri !== 'https://authrim.local/direct-auth/callback' ||
      request.codeChallengeMethod !== 'S256' ||
      !request.codeChallenge ||
      request.codeChallenge.length > 256 ||
      (request.authorizationServer !== undefined && request.authorizationServer !== 'default') ||
      (request.subjectType !== undefined && request.subjectType !== 'end_user') ||
      ttlSeconds > 3600 ||
      maximum > 10000
    )
      throw new Error('aws_authorization_code_profile_unsupported');
    const { code: _code, ...details } = request;
    const encoded = json(details);
    const codeHash = hash(request.code);
    const guardKey = this.table.key(request.tenantId, 'CODE_USER', request.userId, 'GUARD');
    const reservationKey = this.table.key(request.tenantId, 'CODE', codeHash);
    const pad = (value: number) => String(value).padStart(16, '0');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const guard = await this.table.get(guardKey);
      const now = this.table.now();
      const expiresAt = now + ttlSeconds * 1000;
      let count = 0;
      let cursor: Item | undefined;
      do {
        const page = await this.table.client.send(
          new QueryCommand({
            TableName: this.table.tableName,
            ConsistentRead: true,
            Select: 'COUNT',
            Limit: maximum - count,
            KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :start AND :end',
            ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
            ExpressionAttributeValues: {
              ':pk': guardKey.pk,
              ':start': S(`CODE#${pad(now + 1)}#`),
              ':end': S('CODE#9999999999999999#~'),
            },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          })
        );
        if (typeof page.Count !== 'number' || !Number.isSafeInteger(page.Count) || page.Count < 0)
          throw new Error('aws_state_query_invalid');
        count += page.Count;
        cursor = page.LastEvaluatedKey;
        if (count >= maximum) throw new Error('aws_authorization_code_unavailable');
      } while (cursor && Object.keys(cursor).length > 0);
      if (this.table.now() >= expiresAt) throw new Error('aws_authorization_code_expiry_invalid');
      try {
        // Guard revision serializes the strong query with every insert for this user.
        // The tenant-wide reservation also rejects reuse of a code for another user.
        // Guard/reservation have no TTL: removing either would introduce an ABA/duplicate hole.
        await this.table.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.table.tableName,
                  Item: { ...guardKey, revision: S(randomUUID()) },
                  ConditionExpression: guard ? 'revision = :old' : 'attribute_not_exists(pk)',
                  ...(guard
                    ? { ExpressionAttributeValues: { ':old': S(text(guard, 'revision')) } }
                    : {}),
                },
              },
              {
                Put: {
                  TableName: this.table.tableName,
                  Item: {
                    ...reservationKey,
                    payloadJson: S(encoded),
                    createdAtMs: N(now),
                    expiresAtMs: N(expiresAt),
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: this.table.tableName,
                  Item: {
                    pk: guardKey.pk,
                    sk: S(`CODE#${pad(expiresAt)}#${codeHash}`),
                    ttl: N(Math.ceil(expiresAt / 1000)),
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          })
        );
        return { success: true, expiresAt };
      } catch (error) {
        if (!transactionConditional(error)) throw error;
        if (await this.table.get(reservationKey))
          throw new Error('aws_authorization_code_unavailable');
      }
    }
    throw new Error('aws_state_contention');
  }
}

export class DynamoPersistentNameIDRegistry implements PersistentNameIDStore {
  constructor(private readonly table: DynamoStateTable) {}
  async get(input: { tenantId: string; key: string }): Promise<string | null> {
    const bound = persistentNameIDIdentity(input.key);
    if (bound.tenantId !== input.tenantId) throw new Error('aws_persistent_nameid_invalid');
    const item = await this.table.get(this.table.key(input.tenantId, 'NAMEID', input.key));
    if (!item) return null;
    const value = text(item, 'valueJson');
    validateSAMLPersistentNameIDRecord(input.key, value);
    return value;
  }
  async put(input: { tenantId: string; key: string; value: string }): Promise<void> {
    const bound = validateSAMLPersistentNameIDRecord(input.key, input.value);
    if (bound.tenantId !== input.tenantId) throw new Error('aws_persistent_nameid_invalid');
    const decoded = object(JSON.parse(input.value));
    delete decoded.createdAt;
    const semanticHash = hash(canonicalDynamoStateJson(decoded));
    try {
      await this.table.client.send(
        new UpdateItemCommand({
          TableName: this.table.tableName,
          Key: this.table.key(input.tenantId, 'NAMEID', input.key),
          UpdateExpression:
            'SET valueJson = if_not_exists(valueJson, :value), semanticHash = :hash',
          ConditionExpression: 'attribute_not_exists(pk) OR semanticHash = :hash',
          ExpressionAttributeValues: { ':value': S(input.value), ':hash': S(semanticHash) },
        })
      );
    } catch (error) {
      if (conditional(error)) throw new Error('aws_persistent_nameid_conflict');
      throw error;
    }
  }
}
