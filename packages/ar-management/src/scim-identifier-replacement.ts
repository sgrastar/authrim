import {
  createLookupBlindIndexes,
  normalizeLookupEmail,
  produceNotificationDelivery,
  type DatabaseAdapter,
  type Env,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import { revokeIdentifierReplacementCredentials } from './identifier-replacement-credential-revocation';
import { IdentifierReplacementCoordinator } from './identifier-replacement-coordinator';
import {
  IdentifierReplacementOperationRepository,
  type ReplaceableIdentifierKind,
} from './identifier-replacement-operation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

interface ScimIdentifierValues {
  email?: string | null;
  userName?: string | null;
}

export interface SyncScimIdentifierReplacementsInput {
  env: Env;
  core: DatabaseAdapter;
  pii: DatabaseAdapter;
  tenantId: string;
  accountId: string;
  actorRef: string;
  oldValues: ScimIdentifierValues;
  newValues: ScimIdentifierValues;
}

interface PlannedReplacement {
  identifierKind: ReplaceableIdentifierKind;
  oldValue: string;
  newValue: string;
  oldIndexes: LookupBlindIndex[];
  newIndexes: LookupBlindIndex[];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedUserName(value: string): string {
  return value.trim().toLowerCase();
}

function userNameSubject(tenantId: string, value: string): { issuer: string; subject: string } {
  return {
    issuer: `urn:authrim:scim:${tenantId}:username`,
    subject: normalizedUserName(value),
  };
}

async function planReplacements(
  input: SyncScimIdentifierReplacementsInput
): Promise<PlannedReplacement[]> {
  const oldUserName = input.oldValues.userName;
  const newUserName = input.newValues.userName;
  const replaceUserName =
    typeof oldUserName === 'string' &&
    typeof newUserName === 'string' &&
    normalizedUserName(oldUserName) !== normalizedUserName(newUserName);
  const oldEmail = input.oldValues.email;
  const newEmail = input.newValues.email;
  const normalizedOldEmail = typeof oldEmail === 'string' ? normalizeLookupEmail(oldEmail) : null;
  const normalizedNewEmail = typeof newEmail === 'string' ? normalizeLookupEmail(newEmail) : null;
  const replaceEmail =
    normalizedOldEmail !== null &&
    normalizedNewEmail !== null &&
    normalizedOldEmail !== normalizedNewEmail;
  if (!replaceUserName && !replaceEmail) return [];

  const keys = (await loadLookupHmacRuntimeKeys(input.env)).readKeys;
  const plans: PlannedReplacement[] = [];
  if (replaceUserName && typeof oldUserName === 'string' && typeof newUserName === 'string') {
    const [oldIndexes, newIndexes] = await Promise.all([
      createLookupBlindIndexes(
        'external_subject',
        userNameSubject(input.tenantId, oldUserName),
        keys
      ),
      createLookupBlindIndexes(
        'external_subject',
        userNameSubject(input.tenantId, newUserName),
        keys
      ),
    ]);
    plans.push({
      identifierKind: 'external_subject',
      oldValue: oldUserName,
      newValue: newUserName,
      oldIndexes,
      newIndexes,
    });
  }

  if (replaceEmail && normalizedOldEmail !== null && normalizedNewEmail !== null) {
    const [oldIndexes, newIndexes] = await Promise.all([
      createLookupBlindIndexes('email_exact', normalizedOldEmail, keys),
      createLookupBlindIndexes('email_exact', normalizedNewEmail, keys),
    ]);
    plans.push({
      identifierKind: 'email_exact',
      oldValue: normalizedOldEmail,
      newValue: normalizedNewEmail,
      oldIndexes,
      newIndexes,
    });
  }
  return plans;
}

export async function syncScimIdentifierReplacements(
  input: SyncScimIdentifierReplacementsInput
): Promise<void> {
  const plans = await planReplacements(input);
  if (plans.length === 0) return;

  const repository = new IdentifierReplacementOperationRepository(input.pii);
  const lookupForBucket = await createLookupBucketWriteResolver(input.env);
  const coordinator = new IdentifierReplacementCoordinator({
    pii: input.pii,
    lookupForBucket,
    revokeCredentials: (replacement) =>
      revokeIdentifierReplacementCredentials({ env: input.env, core: input.core, ...replacement }),
    enqueueOldIdentifierNotification: async (replacement) => {
      await produceNotificationDelivery(input.env, {
        owner: { owner: 'tenant', tenantId: replacement.tenantId },
        intentId: `identifier-replaced:${replacement.operationId}`,
        outboxId: `notification:${replacement.operationId}`,
        notificationKind: 'account.identifier-replaced',
        idempotencyKey: `identifier-replaced:${replacement.operationId}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: replacement.oldValue,
          from: input.env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Your account email address was changed',
          body: 'The email address for your account was changed. Contact your administrator if you did not request this change.',
        },
      });
    },
  });

  for (const plan of plans) {
    const initialRequestFingerprintSha256 = await sha256(
      JSON.stringify({
        tenantId: input.tenantId,
        accountId: input.accountId,
        identifierKind: plan.identifierKind,
        oldValue: plan.oldValue,
        newValue: plan.newValue,
      })
    );
    const createOperation = async (requestFingerprintSha256: string) => {
      const operationId = `scim-replace:${plan.identifierKind}:${requestFingerprintSha256}`;
      const operation = await repository.create({
        operationId,
        outboxId: `outbox:${operationId}`,
        tenantId: input.tenantId,
        accountId: input.accountId,
        authority: 'scim',
        identifierKind: plan.identifierKind,
        actorRef: input.actorRef,
        idempotencyKeySha256: await sha256(`scim:${requestFingerprintSha256}`),
        requestFingerprintSha256,
        oldValue: plan.oldValue,
        newValue: plan.newValue,
        oldValueSha256: await sha256(plan.oldValue),
        newValueSha256: await sha256(plan.newValue),
        oldIndexes: plan.oldIndexes,
        newIndexes: plan.newIndexes,
        authorityEvidence: { authority: 'scim_bearer' },
        verificationEvidence: { method: 'scim_mapping' },
      });
      return { operationId, operation };
    };

    let created = await createOperation(initialRequestFingerprintSha256);
    if (created.operation.state === 'canceled') {
      const retryFingerprintSha256 = await sha256(
        JSON.stringify({
          requestFingerprintSha256: initialRequestFingerprintSha256,
          canceledAt: created.operation.updatedAt,
        })
      );
      created = await createOperation(retryFingerprintSha256);
    }
    const result = await coordinator.resume({
      operationId: created.operationId,
      tenantId: input.tenantId,
      accountId: input.accountId,
    });
    if (result.state !== 'completed') {
      throw new Error('scim_identifier_replacement_pending');
    }
  }
}
