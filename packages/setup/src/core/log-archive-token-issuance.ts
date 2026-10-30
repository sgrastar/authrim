import { createHash } from 'node:crypto';
import {
  CloudflareTokenAuthorityHttpClient,
  CloudflareTokenBootstrapError,
  createRecoverably,
  deterministicTokenName,
  resumeCloudflareBootstrapTokenRevocation,
  revokeBootstrap,
  inspectCloudflareBootstrapRecoveryToken,
  reconcileCloudflareBootstrapRevocationWithRecoveryToken,
  validateBootstrapPolicy,
  type CloudflareTokenAuthority,
  type CloudflareTokenRecord,
} from './cloudflare-control-token-bootstrap.js';
import {
  LogArchiveApi,
  LogArchiveApiError,
  LOG_ARCHIVE_CATALOG_PERMISSION_PATTERNS,
} from './log-archive.js';
import {
  stageLogArchiveSecrets,
  logArchiveSecretsFingerprint,
  discardIssuedLogArchiveSecrets,
  hasStagedLogArchiveSecrets,
  loadStagedLogArchiveEvidence,
  requireStagedLogArchiveEvidence,
  markStagedLogArchiveBootstrapRevoked,
  type LogArchiveIssuedTokenIds,
  type LogArchiveCatalogSecrets,
} from './log-archive-secrets.js';
import {
  clearPendingBootstrap,
  loadPendingBootstrap,
  stagePendingBootstrap,
  type PendingLogArchiveBootstrap,
} from './pending-control-bootstrap.js';

export class LogArchiveTokenIssuanceError extends Error {
  constructor(
    readonly code: string,
    readonly cleanupRequired = false,
    readonly childCleanupRequired = false
  ) {
    super(code);
  }
}

/** Explicit Catalog credentials are authoritative; mixing sources is rejected before any mutation. */
export function resolveLogArchiveTokenInput(
  env: NodeJS.ProcessEnv
): LogArchiveCatalogSecrets | { bootstrapToken: string } | undefined {
  const readToken = env.LOG_ARCHIVE_CATALOG_READ_TOKEN?.trim();
  const writeToken = env.LOG_ARCHIVE_CATALOG_WRITE_TOKEN?.trim();
  const sinkToken = env.LOG_ARCHIVE_CATALOG_SINK_TOKEN?.trim();
  const bootstrapToken = env.LOG_ARCHIVE_BOOTSTRAP_TOKEN?.trim();
  if (bootstrapToken && (readToken || writeToken || sinkToken))
    throw new LogArchiveTokenIssuanceError('log_archive_token_sources_conflict');
  if (readToken || writeToken || sinkToken) {
    if (!readToken || !writeToken)
      throw new LogArchiveTokenIssuanceError('log_archive_catalog_credentials_required');
    return { readToken, writeToken, ...(sinkToken ? { sinkToken } : {}) };
  }
  return bootstrapToken ? { bootstrapToken } : undefined;
}

function exactPolicy(
  record: CloudflareTokenRecord | null,
  id: string,
  name: string,
  accountId: string,
  groupIds: readonly string[]
): void {
  const policy = record?.policies?.[0];
  const actual = policy?.permission_groups?.map((group) => group.id).sort();
  if (
    !record ||
    record.id !== id ||
    record.name !== name ||
    record.status !== 'active' ||
    record.policies.length !== 1 ||
    policy?.effect !== 'allow' ||
    !actual ||
    JSON.stringify(actual) !== JSON.stringify([...groupIds].sort()) ||
    !policy.resources ||
    Object.keys(policy.resources).length !== 1 ||
    policy.resources[`com.cloudflare.api.account.${accountId}`] !== '*'
  )
    throw new LogArchiveTokenIssuanceError('log_archive_issued_token_scope_invalid');
}

/** IDs and safe codes only may cross this boundary, even when a provider throws a secret value. */
function safeFailure(error: unknown): Error {
  if (error instanceof LogArchiveApiError) return error;
  if (error instanceof LogArchiveTokenIssuanceError) return error;
  if (error instanceof Error && /^log_archive_[a-z0-9_]+$/u.test(error.message))
    return new LogArchiveTokenIssuanceError(error.message);
  if (error instanceof CloudflareTokenBootstrapError)
    return new LogArchiveTokenIssuanceError(
      error.code.startsWith('cloudflare_bootstrap_')
        ? 'log_archive_bootstrap_token_invalid'
        : 'log_archive_token_issuance_failed'
    );
  return new LogArchiveTokenIssuanceError('log_archive_token_issuance_failed');
}

async function cleanupChildren(
  baseDir: string,
  authority: CloudflareTokenAuthority,
  artifact: PendingLogArchiveBootstrap
): Promise<boolean> {
  try {
    const inventory = await authority.listTokens();
    const ids = new Set(artifact.childTokenIds);
    for (const token of inventory) {
      if (
        artifact.childTokenNames.includes(token.name) &&
        !artifact.preservedTokenIds.includes(token.id) &&
        token.id !== artifact.bootstrapTokenId
      ) {
        ids.add(token.id);
        if (token.name === artifact.pendingCreateName) artifact.pendingCreateName = null;
      }
    }
    // Persist the observed create's ID and resolved name together BEFORE deleting it.
    artifact.childTokenIds = [...ids];
    await stagePendingBootstrap({ baseDir, artifact });
    for (const id of ids) {
      if (inventory.some((token) => token.id === id)) {
        try {
          await authority.deleteToken(id);
        } catch {
          // A lost response or a repeated DELETE is resolved by the authenticated list below.
        }
      }
      const remaining = await authority.listTokens();
      if (!remaining.some((token) => token.id === id)) {
        artifact.childTokenIds = artifact.childTokenIds.filter((childId) => childId !== id);
        await stagePendingBootstrap({ baseDir, artifact });
      }
    }
    const remaining = await authority.listTokens();
    artifact.childTokenIds = [...ids].filter((id) => remaining.some((token) => token.id === id));
    await stagePendingBootstrap({ baseDir, artifact });
    return artifact.childTokenIds.length === 0 && artifact.pendingCreateName === null;
  } catch {
    return false;
  }
}

export interface LogArchiveTokenIssuanceInput {
  baseDir: string;
  environment: string;
  accountId: string;
  mode: 'scheduled' | 'pipeline';
  bootstrapToken: string;
  authority?: CloudflareTokenAuthority;
  fetcher?: typeof fetch;
  keysDir?: string;
}

export type LogArchiveTokenIssuanceResult = LogArchiveIssuedTokenIds & {
  warning?: 'log_archive_local_cleanup_pending';
};

function bootstrapFingerprint(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

function issuedIds(artifact: PendingLogArchiveBootstrap): LogArchiveIssuedTokenIds {
  return {
    readTokenId: artifact.childTokenIds[0]!,
    writeTokenId: artifact.childTokenIds[1]!,
    ...(artifact.childTokenIds[2] ? { sinkTokenId: artifact.childTokenIds[2] } : {}),
  };
}

/** A confirmed remote commit must never be rolled back by local checkpoint/unlink/fsync failures. */
async function completeIssuedTokens(
  input: LogArchiveTokenIssuanceInput,
  artifact: PendingLogArchiveBootstrap
): Promise<LogArchiveTokenIssuanceResult> {
  artifact.bootstrapRevoked = true;
  let warning = false;
  try {
    await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
  } catch {
    warning = true;
  }
  let committed = false;
  try {
    await markStagedLogArchiveBootstrapRevoked(
      input.baseDir,
      input.environment,
      artifact.stagedSecretsFingerprint!,
      [
        bootstrapFingerprint(input.bootstrapToken),
        ...(artifact.recoveryToken ? [bootstrapFingerprint(artifact.recoveryToken.token)] : []),
      ]
    );
    committed = true;
  } catch {
    warning = true;
  }
  // Keep the WAL until the companion receipt can independently prove the confirmed self-DELETE.
  if (committed) {
    try {
      await clearPendingBootstrap({
        baseDir: input.baseDir,
        environment: input.environment,
        purpose: 'log-archive',
      });
    } catch {
      warning = true;
    }
  }
  return {
    ...issuedIds(artifact),
    ...(warning ? { warning: 'log_archive_local_cleanup_pending' as const } : {}),
  };
}

/** Shared CLI/Web preparation. Verified, committed local evidence avoids replaying a revoked bootstrap. */
export async function ensureLogArchiveTokens(
  input: LogArchiveTokenIssuanceInput
): Promise<LogArchiveTokenIssuanceResult & { reused?: true }> {
  const pending = await loadPendingBootstrap({
    baseDir: input.baseDir,
    environment: input.environment,
    purpose: 'log-archive',
  });
  if (pending) {
    const result = await issueLogArchiveTokens(input);
    return { ...result, ...(pending.phase === 'issued' ? { reused: true as const } : {}) };
  }
  const evidence = await loadStagedLogArchiveEvidence(
    input.baseDir,
    input.environment,
    input.keysDir
  );
  if (evidence) {
    await requireStagedLogArchiveEvidence(
      input.baseDir,
      input.environment,
      input.accountId,
      input.mode,
      input.keysDir
    );
    if (
      evidence.bootstrapRevoked &&
      evidence.issuance &&
      [
        evidence.issuance.bootstrapTokenFingerprint,
        ...(evidence.issuance.consumedBootstrapFingerprints ?? []),
      ].includes(bootstrapFingerprint(input.bootstrapToken))
    ) {
      const { readTokenId, writeTokenId, sinkTokenId } = evidence.issuance;
      return { readTokenId, writeTokenId, ...(sinkTokenId ? { sinkTokenId } : {}), reused: true };
    }
    throw new LogArchiveTokenIssuanceError('log_archive_staged_credentials_exist', true);
  }
  return issueLogArchiveTokens(input);
}

export async function issueLogArchiveTokens(
  input: LogArchiveTokenIssuanceInput
): Promise<LogArchiveTokenIssuanceResult> {
  if (
    !/^[a-f0-9]{32}$/u.test(input.accountId) ||
    !/^[a-z][a-z0-9-]{0,31}$/u.test(input.environment) ||
    !['scheduled', 'pipeline'].includes(input.mode)
  )
    throw new LogArchiveTokenIssuanceError('log_archive_request_invalid');
  const bootstrapToken = input.bootstrapToken.trim();
  const authority =
    input.authority ??
    new CloudflareTokenAuthorityHttpClient({
      accountId: input.accountId,
      ownership: 'account',
      bootstrapToken,
      fetcher: input.fetcher,
    });
  const recoveryInput = {
    baseDir: input.baseDir,
    environment: input.environment,
    purpose: 'log-archive' as const,
  };
  const pending = await loadPendingBootstrap(recoveryInput);
  if (pending) {
    if (pending.accountId !== input.accountId)
      throw new LogArchiveTokenIssuanceError('log_archive_recovery_account_mismatch', true);
    if (pending.phase === 'issued') {
      const evidence = await requireStagedLogArchiveEvidence(
        input.baseDir,
        input.environment,
        input.accountId,
        input.mode
      );
      if (
        evidence.secretsFingerprint !== pending.stagedSecretsFingerprint ||
        evidence.issuance?.bootstrapTokenId !== pending.bootstrapTokenId ||
        JSON.stringify(issuedIds(pending)) !==
          JSON.stringify({
            readTokenId: evidence.issuance.readTokenId,
            writeTokenId: evidence.issuance.writeTokenId,
            ...(evidence.issuance.sinkTokenId
              ? { sinkTokenId: evidence.issuance.sinkTokenId }
              : {}),
          })
      )
        throw new LogArchiveTokenIssuanceError('log_archive_secret_file_invalid', true);
      if (pending.bootstrapRevoked || evidence.bootstrapRevoked) {
        if (
          bootstrapToken !== pending.bootstrapToken &&
          bootstrapToken !== pending.recoveryToken?.token
        )
          throw new LogArchiveTokenIssuanceError('log_archive_staged_credentials_exist', true);
        return completeIssuedTokens(input, pending);
      }
    }
    let recovery = pending.recoveryToken;
    const candidateToken = recovery?.token ?? pending.bootstrapToken;
    let recoveryAuthority =
      input.authority ??
      new CloudflareTokenAuthorityHttpClient({
        accountId: pending.accountId,
        ownership: pending.ownership,
        bootstrapToken: candidateToken,
        fetcher: input.fetcher,
      });
    // A newly supplied narrow authority can prove a response-lost self-revocation independently.
    // Persist that authority before using it so a second interruption remains recoverable.
    if (bootstrapToken !== candidateToken && bootstrapToken !== pending.bootstrapToken) {
      recoveryAuthority =
        input.authority ??
        new CloudflareTokenAuthorityHttpClient({
          accountId: pending.accountId,
          ownership: 'account',
          bootstrapToken,
          fetcher: input.fetcher,
        });
      try {
        const inspected = await inspectCloudflareBootstrapRecoveryToken({
          accountId: pending.accountId,
          ownership: 'account',
          authority: recoveryAuthority,
        });
        if (
          pending.revocationTargetTokenIds.includes(inspected.tokenId) ||
          pending.childTokenIds.includes(inspected.tokenId)
        )
          throw new Error();
        if (recovery) pending.revocationTargetTokenIds.push(recovery.tokenId);
        recovery = { token: bootstrapToken, tokenId: inspected.tokenId };
        pending.recoveryToken = recovery;
        await stagePendingBootstrap({ baseDir: input.baseDir, artifact: pending });
      } catch {
        throw new LogArchiveTokenIssuanceError(
          'log_archive_bootstrap_revocation_unconfirmed',
          true
        );
      }
    }
    if (pending.phase === 'issued') {
      try {
        if (recovery)
          await reconcileCloudflareBootstrapRevocationWithRecoveryToken({
            accountId: pending.accountId,
            ownership: 'account',
            expectedRecoveryTokenId: recovery.tokenId,
            revocationTargetTokenIds: pending.revocationTargetTokenIds,
            authority: recoveryAuthority,
          });
        else
          await resumeCloudflareBootstrapTokenRevocation({
            accountId: pending.accountId,
            ownership: pending.ownership,
            expectedBootstrapTokenId: pending.bootstrapTokenId,
            authority: recoveryAuthority,
          });
      } catch {
        throw new LogArchiveTokenIssuanceError(
          'log_archive_bootstrap_revocation_unconfirmed',
          true
        );
      }
      return completeIssuedTokens(input, pending);
    }
    let childrenClean = await cleanupChildren(input.baseDir, recoveryAuthority, pending);
    try {
      await discardIssuedLogArchiveSecrets(
        input.baseDir,
        input.environment,
        pending.stagedSecretsFingerprint
      );
    } catch {
      childrenClean = false;
    }
    try {
      if (recovery)
        await reconcileCloudflareBootstrapRevocationWithRecoveryToken({
          accountId: pending.accountId,
          ownership: 'account',
          expectedRecoveryTokenId: recovery.tokenId,
          revocationTargetTokenIds: pending.revocationTargetTokenIds,
          authority: recoveryAuthority,
        });
      else
        await resumeCloudflareBootstrapTokenRevocation({
          accountId: pending.accountId,
          ownership: pending.ownership,
          expectedBootstrapTokenId: pending.bootstrapTokenId,
          authority: recoveryAuthority,
        });
    } catch {
      throw new LogArchiveTokenIssuanceError(
        'log_archive_bootstrap_revocation_unconfirmed',
        true,
        !childrenClean
      );
    }
    if (!childrenClean)
      throw new LogArchiveTokenIssuanceError('log_archive_child_cleanup_unconfirmed', true, true);
    await clearPendingBootstrap(recoveryInput);
    throw new LogArchiveTokenIssuanceError('log_archive_bootstrap_recovered_retry_required');
  }
  if (hasStagedLogArchiveSecrets(input.baseDir, input.environment))
    throw new LogArchiveTokenIssuanceError('log_archive_staged_credentials_exist', true);
  let artifact: PendingLogArchiveBootstrap | undefined;
  let revoked = false;
  try {
    // Account-only preflight uses the same identity/policy checks as Control. Stage before any POST.
    const self = await authority.verifySelf();
    if (!self || self.status !== 'active' || !/^[a-f0-9]{32}$/u.test(self.id))
      throw new LogArchiveTokenIssuanceError('log_archive_bootstrap_token_invalid', true);
    artifact = {
      version: 2,
      phase: 'creating',
      bootstrapRevoked: false,
      purpose: 'log-archive',
      environment: input.environment,
      accountId: input.accountId,
      ownership: 'account',
      bootstrapToken,
      bootstrapTokenId: self.id,
      childTokenIds: [],
      childTokenNames: [],
      preservedTokenIds: [],
      pendingCreateName: null,
      stagedSecretsFingerprint: null,
      recoveryToken: null,
      revocationTargetTokenIds: [self.id],
    };
    await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
    const bootstrap = await authority.getToken(self.id);
    if (!bootstrap || bootstrap.id !== self.id)
      throw new LogArchiveTokenIssuanceError('log_archive_bootstrap_token_invalid');
    validateBootstrapPolicy(bootstrap, 'account', input.accountId);
    const groups = await authority.listPermissionGroups('com.cloudflare.api.account');
    const specs = [
      { role: 'catalogRead', names: ['Workers R2 Data Catalog Read'] },
      { role: 'sqlRead', names: ['Workers R2 SQL Read'] },
      { role: 'storageRead', names: ['Workers R2 Storage Read'] },
      {
        role: 'catalogWrite',
        names: ['Workers R2 Data Catalog Write', 'Workers R2 Data Catalog Edit'],
      },
      { role: 'storageWrite', names: ['Workers R2 Storage Write', 'Workers R2 Storage Edit'] },
    ] as const;
    const accountGroups = groups.filter((group) =>
      group.scopes.includes('com.cloudflare.api.account')
    );
    const selected = specs.map(({ role, names }) => {
      const exact = accountGroups.filter((group) =>
        (names as readonly string[]).includes(group.name)
      );
      const matches =
        exact.length > 0
          ? exact
          : accountGroups.filter((group) =>
              LOG_ARCHIVE_CATALOG_PERMISSION_PATTERNS[role].test(group.name)
            );
      if (matches.length !== 1)
        throw new LogArchiveTokenIssuanceError('log_archive_permission_group_invalid');
      return matches[0]!;
    });
    if (
      new Set(selected.map((group) => group.id)).size !== 5 ||
      selected.slice(0, 3).some((group) => /write|edit|admin/iu.test(group.name))
    )
      throw new LogArchiveTokenIssuanceError('log_archive_permission_group_invalid');
    artifact.preservedTokenIds = (await authority.listTokens()).map((token) => token.id);
    const children: CloudflareTokenRecord[] = [];
    for (const role of input.mode === 'pipeline' ? ['read', 'write', 'sink'] : ['read', 'write']) {
      const groupIds = (role === 'read' ? selected.slice(0, 3) : selected.slice(3)).map(
        (group) => group.id
      );
      const name = deterministicTokenName(
        input.accountId,
        input.environment,
        `log-archive-${role}`
      );
      const checkpoint = artifact;
      let postPrepared = false;
      let creation: Awaited<ReturnType<typeof createRecoverably>>;
      try {
        creation = await createRecoverably(
          authority,
          {
            name,
            policies: [
              {
                effect: 'allow',
                permission_groups: groupIds.map((id) => ({ id })),
                resources: { [`com.cloudflare.api.account.${input.accountId}`]: '*' },
              },
            ],
          },
          undefined,
          {
            beforePost: async ({ existingTokens }) => {
              postPrepared = false;
              checkpoint.preservedTokenIds = [
                ...new Set([
                  ...checkpoint.preservedTokenIds,
                  ...existingTokens.filter((token) => token.name === name).map((token) => token.id),
                ]),
              ];
              if (!checkpoint.childTokenNames.includes(name)) checkpoint.childTokenNames.push(name);
              checkpoint.pendingCreateName = name;
              await stagePendingBootstrap({ baseDir: input.baseDir, artifact: checkpoint });
              postPrepared = true;
            },
            afterObserved: async (token) => {
              if (token.id === self.id || checkpoint.preservedTokenIds.includes(token.id))
                throw new LogArchiveTokenIssuanceError('log_archive_issued_token_scope_invalid');
              if (!checkpoint.childTokenIds.includes(token.id))
                checkpoint.childTokenIds.push(token.id);
              checkpoint.pendingCreateName = null;
              await stagePendingBootstrap({ baseDir: input.baseDir, artifact: checkpoint });
            },
            afterDeleted: async (id) => {
              checkpoint.childTokenIds = checkpoint.childTokenIds.filter(
                (childId) => childId !== id
              );
              await stagePendingBootstrap({ baseDir: input.baseDir, artifact: checkpoint });
            },
          }
        );
      } catch (error) {
        // No POST, a definitive rejection, or an observed-and-removed ambiguous result.
        if (
          !postPrepared ||
          (error instanceof CloudflareTokenBootstrapError &&
            !error.cleanupRequired &&
            [
              'cloudflare_child_token_create_failed',
              'cloudflare_child_token_create_transient',
            ].includes(error.code))
        ) {
          artifact.pendingCreateName = null;
          await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
        }
        throw error;
      }
      const { token } = creation;
      exactPolicy(token, token.id, name, input.accountId, groupIds);
      if (
        !token.value ||
        token.value === bootstrapToken ||
        children.some((child) => child.id === token.id || child.value === token.value)
      )
        throw new LogArchiveTokenIssuanceError('log_archive_distinct_catalog_credentials_required');
      const verified = await authority.verifyIssuedToken(token.value);
      if (verified?.id !== token.id || verified.status !== 'active')
        throw new LogArchiveTokenIssuanceError('log_archive_catalog_token_inactive');
      exactPolicy(await authority.getToken(token.id), token.id, name, input.accountId, groupIds);
      children.push(token);
    }
    const secrets = {
      readToken: children[0]!.value!,
      writeToken: children[1]!.value!,
      ...(children[2] ? { sinkToken: children[2].value! } : {}),
    };
    await new LogArchiveApi(
      input.accountId,
      bootstrapToken,
      input.fetcher
    ).verifyCatalogCredentials(secrets.readToken, secrets.writeToken, secrets.sinkToken);
    artifact.stagedSecretsFingerprint = logArchiveSecretsFingerprint(secrets);
    await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
    await stageLogArchiveSecrets(input.baseDir, input.environment, secrets, {
      accountId: input.accountId,
      mode: input.mode,
      issuance: {
        ...issuedIds(artifact),
        bootstrapTokenId: self.id,
        bootstrapTokenFingerprint: bootstrapFingerprint(bootstrapToken),
      },
    });
    artifact.phase = 'issued';
    await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
    try {
      await revokeBootstrap(authority, self.id);
      revoked = true;
    } catch {
      throw new LogArchiveTokenIssuanceError('log_archive_bootstrap_revocation_unconfirmed', true);
    }
    return completeIssuedTokens(input, artifact);
  } catch (error) {
    if (revoked && artifact)
      return { ...issuedIds(artifact), warning: 'log_archive_local_cleanup_pending' };
    if (!artifact)
      throw new LogArchiveTokenIssuanceError('log_archive_bootstrap_revocation_unconfirmed', true);
    if (artifact.phase === 'issued') {
      // Only an independently observed still-active bootstrap permits rolling an issued phase back.
      // A lost self-DELETE response must retain the valid staged result for forward recovery.
      try {
        const self = await authority.verifySelf();
        if (self?.id !== artifact.bootstrapTokenId || self.status !== 'active') throw new Error();
        artifact.phase = 'creating';
        await stagePendingBootstrap({ baseDir: input.baseDir, artifact });
      } catch {
        throw new LogArchiveTokenIssuanceError(
          'log_archive_bootstrap_revocation_unconfirmed',
          true
        );
      }
    }
    let childCleanupRequired = false;
    if (artifact) {
      childCleanupRequired = !(await cleanupChildren(input.baseDir, authority, artifact));
      try {
        await discardIssuedLogArchiveSecrets(
          input.baseDir,
          input.environment,
          artifact.stagedSecretsFingerprint
        );
      } catch {
        childCleanupRequired = true;
      }
      try {
        await revokeBootstrap(authority, artifact.bootstrapTokenId);
        if (!childCleanupRequired) await clearPendingBootstrap(recoveryInput);
      } catch {
        throw new LogArchiveTokenIssuanceError(
          'log_archive_bootstrap_revocation_unconfirmed',
          true,
          childCleanupRequired
        );
      }
    }
    if (childCleanupRequired)
      throw new LogArchiveTokenIssuanceError('log_archive_child_cleanup_unconfirmed', true, true);
    throw safeFailure(error);
  }
}
