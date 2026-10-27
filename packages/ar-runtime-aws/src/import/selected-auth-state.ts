/** Select one authoritative auth-state backend; SQL audit/activation remains independent. */
import type { Pool } from 'pg';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createAwsStateStores } from '../storage/create-state-stores';
import { createDynamoStateClient } from '../storage/dynamodb-state';
import {
  normalizeAwsAuthStateConfig,
  dynamoAuthStateTableName,
  type AwsAuthStateConfig,
  type DynamoAuthStateConfig,
} from '../storage/auth-state-config';
import type { AwsStateStores } from '../storage/state-ports';
import {
  assertVerifiedAwsStateSource,
  assertVerifiedAwsStateRestored,
  assertAwsLiveStateCompatible,
  restoreVerifiedAwsState,
  type AwsStateRestoreReceipt,
} from './state-restore';
import {
  assertDynamoAuthStateTable,
  assertDynamoAuthStateSealed,
  assertVerifiedDynamoAuthStateRestored,
  assertDynamoAuthStateLiveCompatible,
  createDynamoAuthStateRestoreReceipt,
  readDynamoAuthStateCounters,
  restoreVerifiedDynamoAuthState,
  type DynamoAuthStateSource,
  type DynamoAuthStateRestoreReceipt,
} from './auth-state-restore';
import { restoreEvidenceDigest } from './restore-evidence';

export interface AwsBoundAuthState {
  stores: AwsStateStores;
  assertReady(): Promise<void>;
}

export type AwsSelectedAuthStateEvidence =
  | { config: { backend: 'postgresql' } }
  | { config: DynamoAuthStateConfig; receipt: DynamoAuthStateRestoreReceipt };

/** In-process test seam only. No endpoint or credentials are accepted from deployment documents. */
export interface AwsAuthStateDependencies {
  createDynamoClient?(target: DynamoAuthStateConfig): DynamoDBClient;
}

export function awsAuthStateConfigurationEvidence(
  value: AwsAuthStateConfig | undefined,
  restoreId?: string
): { authState?: AwsAuthStateConfig } {
  const config = normalizeAwsAuthStateConfig(value, { restoreId });
  // Keep pre-selector activation hashes readable; explicit PG remains pinned as explicit PG.
  return value === undefined ? {} : { authState: config };
}

export function selectAwsAuthState(
  input: Omit<DynamoAuthStateSource, 'target'> & {
    authState?: AwsAuthStateConfig;
    restoreId: string;
    stateDb: Pool;
  },
  dependencies: AwsAuthStateDependencies = {}
) {
  const config = normalizeAwsAuthStateConfig(input.authState, { restoreId: input.restoreId });
  assertVerifiedAwsStateSource(input);
  if (config.backend === 'dynamodb') {
    const client =
      dependencies.createDynamoClient?.(config) ??
      createDynamoStateClient({ region: config.region });
    const source = { ...input, target: config, client };
    const receipt = createDynamoAuthStateRestoreReceipt(source);
    const verification = { ...source, receipt };
    const bound: AwsBoundAuthState = {
      stores: createAwsStateStores({
        backend: 'dynamodb',
        client,
        tableName: dynamoAuthStateTableName(config),
        namespace: config.namespace,
      }),
      assertReady: () => assertDynamoAuthStateSealed({ client, target: config, receipt }),
    };
    return {
      evidence: { config, receipt } as AwsSelectedAuthStateEvidence,
      receipt,
      bound,
      restore: async () => {
        await assertDynamoAuthStateTable(client, config);
        const actual = await restoreVerifiedDynamoAuthState({
          ...source,
          restoreId: input.restoreId,
        });
        if (restoreEvidenceDigest(actual) !== restoreEvidenceDigest(receipt))
          throw new Error('aws_auth_state_receipt_mismatch');
      },
      assertStaging: () => assertVerifiedDynamoAuthStateRestored(verification),
      assertLive: async () => {
        await assertDynamoAuthStateTable(client, config);
        await assertDynamoAuthStateLiveCompatible(verification);
      },
      readPasskeyCounters: () =>
        readDynamoAuthStateCounters({
          client,
          target: config,
          receipt,
          passkeys: input.expected.passkeys,
        }),
      close: async () => {
        client.destroy();
      },
    };
  }
  const { manifest, supplement } = input;
  const receipt: AwsStateRestoreReceipt = {
    tenantId: manifest.source.tenantId,
    source: { ...manifest.source },
    bundleId: manifest.bundleId,
    snapshotId: manifest.snapshotId,
    inventoryDigestSha256: manifest.inventoryDigestSha256,
    supplementSha256: supplement.receipt.supplementSha256,
    accountAuthStates: supplement.accountAuthStates.length,
    passkeyCounters: supplement.passkeyCounters.length,
    persistentNameIds: supplement.persistentNameIds.length,
  };
  const source: Parameters<typeof restoreVerifiedAwsState>[0] = {
    manifest,
    supplement,
    expected: input.expected,
    connection: {
      withDedicatedConnection: async (run) => {
        const client = await input.stateDb.connect();
        try {
          return await run(client);
        } finally {
          client.release();
        }
      },
    },
  };
  const bound: AwsBoundAuthState = {
    stores: createAwsStateStores({ backend: 'postgresql', db: input.stateDb }),
    assertReady: async () => undefined,
  };
  return {
    evidence: { config } as AwsSelectedAuthStateEvidence,
    receipt,
    bound,
    restore: async () => {
      const actual = await restoreVerifiedAwsState(source);
      if (restoreEvidenceDigest(actual) !== restoreEvidenceDigest(receipt))
        throw new Error('aws_auth_state_receipt_mismatch');
    },
    assertStaging: () => assertVerifiedAwsStateRestored({ ...source, receipt }),
    assertLive: () => assertAwsLiveStateCompatible({ ...source, receipt }),
    readPasskeyCounters: async () =>
      (
        await input.stateDb.query<{
          user_id: string;
          credential_id: string;
          counter: string;
        }>(
          'SELECT user_id,credential_id,counter FROM authrim_aws_passkey_counters WHERE tenant_id=$1',
          [manifest.source.tenantId]
        )
      ).rows,
    close: async () => undefined,
  };
}
