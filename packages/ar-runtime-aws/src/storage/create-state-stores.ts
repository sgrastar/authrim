/** Explicit backend selection; no implicit fallback or dual writing. */
import type { AwsStateStores } from './state-ports';
import { PostgresTransientStateStore, type PostgresQueryClient } from './postgres-transient-state';
import { PostgresAccountAuthStateStore } from './postgres-account-auth-state';
import { PostgresAuthorizationCodeStore } from './postgres-authorization-code';
import { PostgresRateLimitStore } from './postgres-rate-limit';
import { PostgresPersistentNameIDRegistry } from './postgres-persistent-nameid';
import {
  DynamoStateTable,
  DynamoTransientStateStore,
  DynamoAccountAuthStateStore,
  DynamoAuthorizationCodeStore,
  DynamoRateLimitStore,
  DynamoPersistentNameIDRegistry,
  type DynamoStateOptions,
} from './dynamodb-state';

export function createAwsStateStores(
  input:
    | { backend: 'postgresql'; db: PostgresQueryClient }
    | ({ backend: 'dynamodb' } & DynamoStateOptions)
): AwsStateStores {
  if (input.backend === 'postgresql') {
    return {
      state: new PostgresTransientStateStore(input.db),
      accountAuthentication: new PostgresAccountAuthStateStore(input.db),
      authorizationCodes: new PostgresAuthorizationCodeStore(input.db),
      rateLimit: new PostgresRateLimitStore(input.db),
      persistentNameIDs: new PostgresPersistentNameIDRegistry(input.db),
    };
  }
  if (input.backend !== 'dynamodb') throw new Error('aws_state_backend_unsupported');
  const table = new DynamoStateTable(input);
  return {
    state: new DynamoTransientStateStore(table),
    accountAuthentication: new DynamoAccountAuthStateStore(table),
    authorizationCodes: new DynamoAuthorizationCodeStore(table),
    rateLimit: new DynamoRateLimitStore(table),
    persistentNameIDs: new DynamoPersistentNameIDRegistry(table),
  };
}
