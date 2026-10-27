import type {
  EnvironmentAuthority,
  EnvironmentDrainRequest,
  EnvironmentGenerationRecord,
  EnvironmentGenerationProof,
  EnvironmentOperationIdentity,
  EnvironmentPairDefinition,
  EnvironmentWritePermit,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import type {
  DeploymentAuthority,
  DeploymentStandbyGeneration,
  DeploymentFailoverGeneration,
  DeploymentDrainRequest,
  DeploymentOperationIdentity,
  DeploymentPairDefinition,
  DeploymentVerifiedGeneration,
  DeploymentWritePermit,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import {
  assertReplicationIdentifier,
  assertReplicationSecret,
  parseReplicationRpc,
  REPLICATION_RPC_MAX_BYTES,
  REPLICATION_RPC_PATH,
  replicationCanonicalJson,
  verifyReplicationRpc,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import type {
  ReplicationGenerationCatalog,
  ReplicationGenerationLocation,
} from './generation-catalog';

interface AuthorityCredentialBase {
  credentialId: string;
  secret: string;
  pairId: string;
  role: 'controller' | 'writer';
  /** Required for writers, absent for controllers. Never taken from the request identity. */
  deploymentId?: string;
}

export type ReplicationAuthorityCredential = AuthorityCredentialBase &
  ({ tenantId: string; environmentId?: never } | { environmentId: string; tenantId?: never });

async function readBounded(request: Request): Promise<string> {
  if (!request.body) throw new Error();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REPLICATION_RPC_MAX_BYTES) throw new Error();
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Isolated control service: contains no login, restore, export, or cloud administration route. */
export function createReplicationAuthorityHttp(input: {
  authority: DeploymentAuthority;
  environmentAuthority?: EnvironmentAuthority;
  catalog?: ReplicationGenerationCatalog;
  credentials: readonly ReplicationAuthorityCredential[];
  now?: () => number;
}) {
  const credentials = new Map<string, ReplicationAuthorityCredential>();
  for (const value of input.credentials) {
    const credential = structuredClone(value);
    for (const id of [
      credential.credentialId,
      credential.pairId,
      credential.environmentId ?? credential.tenantId,
    ])
      assertReplicationIdentifier(id);
    assertReplicationSecret(credential.secret);
    if (
      (credential.environmentId !== undefined && credential.tenantId !== undefined) ||
      credentials.has(credential.credentialId) ||
      (credential.role !== 'writer' && credential.role !== 'controller') ||
      (credential.role === 'controller' && credential.deploymentId !== undefined)
    )
      throw new Error('replication_authority_credentials_invalid');
    if (credential.role === 'writer') assertReplicationIdentifier(credential.deploymentId);
    credentials.set(credential.credentialId, credential);
  }
  if (credentials.size === 0) throw new Error('replication_authority_credentials_invalid');
  const response = (body: unknown, status = 200) =>
    new Response(replicationCanonicalJson(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== REPLICATION_RPC_PATH || url.search)
      return response({ error: 'not_found' }, 404);
    try {
      if (request.headers.get('content-type') !== 'application/json') throw new Error();
      const raw = await readBounded(request);
      const envelope = parseReplicationRpc(raw, (input.now ?? Date.now)());
      const credential = credentials.get(envelope.credentialId);
      if (
        !credential ||
        !(await verifyReplicationRpc(
          raw,
          request.headers.get('x-authrim-replication-signature') ?? '',
          credential.secret
        ))
      )
        throw new Error();
      const payload = envelope.payload as Record<string, unknown>;
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        payload.pairId !== credential.pairId
      )
        throw new Error();
      if (credential.environmentId !== undefined) {
        if (
          payload.environmentId !== credential.environmentId ||
          !input.environmentAuthority ||
          !envelope.action.startsWith('environment')
        )
          throw new Error();
        const writes = ['environmentEnter', 'environmentComplete'];
        if (
          credential.role === 'writer' &&
          (![...writes, 'environmentGetServingGeneration'].includes(envelope.action) ||
            payload.deploymentId !== credential.deploymentId)
        )
          throw new Error();
        if (credential.role === 'controller' && writes.includes(envelope.action)) throw new Error();
        const a = input.environmentAuthority;
        switch (envelope.action) {
          case 'environmentInitialize':
            return response(await a.initialize(payload as unknown as EnvironmentPairDefinition));
          case 'environmentGet':
            if (Object.keys(payload).sort().join(',') !== 'environmentId,pairId') throw new Error();
            return response(await a.get(credential.pairId, credential.environmentId));
          case 'environmentEnter':
            return response(await a.enter(payload as unknown as EnvironmentWritePermit));
          case 'environmentComplete':
            await a.complete(payload as unknown as EnvironmentWritePermit);
            return response({ completed: true });
          case 'environmentBeginDrain':
            return response(await a.beginDrain(payload as unknown as EnvironmentDrainRequest));
          case 'environmentGetOperation':
            return response(
              await a.getOperation(payload as unknown as EnvironmentOperationIdentity)
            );
          case 'environmentRegisterGeneration':
            await a.registerGeneration(payload as unknown as EnvironmentGenerationRecord);
            return response({ registered: true });
          case 'environmentGetGeneration':
            if (
              Object.keys(payload).sort().join(',') !==
              'deploymentId,environmentId,epoch,generationId,pairId'
            )
              throw new Error();
            return response(
              await a.getGeneration(
                payload as unknown as Parameters<EnvironmentAuthority['getGeneration']>[0]
              )
            );
          case 'environmentGetServingGeneration':
            if (Object.keys(payload).sort().join(',') !== 'deploymentId,environmentId,pairId')
              throw new Error();
            return response(
              await a.getServingGeneration(
                payload as unknown as Parameters<EnvironmentAuthority['getServingGeneration']>[0]
              )
            );
          case 'environmentVerifyGeneration':
            if (Object.keys(payload).sort().join(',') !== 'environmentId,operationId,pairId,proof')
              throw new Error();
            return response(
              await a.verifyGeneration(
                {
                  pairId: credential.pairId,
                  environmentId: credential.environmentId,
                  operationId: payload.operationId,
                } as EnvironmentOperationIdentity,
                payload.proof as EnvironmentGenerationProof
              )
            );
          case 'environmentPromote':
            return response(await a.promote(payload as unknown as EnvironmentOperationIdentity));
          case 'environmentCancelDrain':
            return response(
              await a.cancelDrain(payload as unknown as EnvironmentOperationIdentity)
            );
          default:
            throw new Error();
        }
      }
      if (payload.tenantId !== credential.tenantId || payload.environmentId !== undefined)
        throw new Error();
      if (
        credential.role === 'writer' &&
        (!['enter', 'complete', 'getServingGeneration'].includes(envelope.action) ||
          payload.deploymentId !== credential.deploymentId)
      )
        throw new Error();
      if (credential.role === 'controller' && ['enter', 'complete'].includes(envelope.action))
        throw new Error();
      const authority = input.authority;
      switch (envelope.action) {
        case 'initialize':
          return response(
            await authority.initialize(payload as unknown as DeploymentPairDefinition)
          );
        case 'get':
          return response(
            await authority.get(credential.pairId, credential.environmentId ?? credential.tenantId)
          );
        case 'registerGeneration':
          if (!input.catalog) throw new Error();
          await input.catalog.register(payload as unknown as ReplicationGenerationLocation);
          return response({ registered: true });
        case 'getServingGeneration': {
          if (
            !input.catalog ||
            Object.keys(payload).sort().join(',') !== 'deploymentId,pairId,tenantId'
          )
            throw new Error();
          const state = await authority.get(
            credential.pairId,
            credential.environmentId ?? credential.tenantId
          );
          if (state.phase !== 'active' || state.ownerDeploymentId !== payload.deploymentId)
            throw new Error();
          return response(
            await input.catalog.get({
              pairId: credential.pairId,
              tenantId: credential.tenantId,
              deploymentId: state.ownerDeploymentId,
              generationId: state.selectedGenerationId,
              epoch: state.epoch,
            })
          );
        }
        case 'enter':
          return response(await authority.enter(payload as unknown as DeploymentWritePermit));
        case 'complete':
          await authority.complete(payload as unknown as DeploymentWritePermit);
          return response({ completed: true });
        case 'beginDrain':
          return response(await authority.beginDrain(payload as unknown as DeploymentDrainRequest));
        case 'beginFailoverDrain':
          return response(
            await authority.beginFailoverDrain(payload as unknown as DeploymentDrainRequest)
          );
        case 'registerStandbyGeneration':
          await authority.registerStandbyGeneration(
            payload as unknown as DeploymentStandbyGeneration
          );
          return response({ registered: true });
        case 'verifyFailoverGeneration': {
          if (Object.keys(payload).sort().join(',') !== 'operationId,pairId,proof,tenantId')
            throw new Error();
          return response(
            await authority.verifyFailoverGeneration(
              {
                pairId: credential.pairId,
                tenantId: credential.tenantId,
                operationId: payload.operationId,
              } as DeploymentOperationIdentity,
              payload.proof as DeploymentFailoverGeneration
            )
          );
        }
        case 'getOperation':
          return response(
            await authority.getOperation(payload as unknown as DeploymentOperationIdentity)
          );
        case 'verifyGeneration': {
          if (Object.keys(payload).sort().join(',') !== 'generation,operationId,pairId,tenantId')
            throw new Error();
          const identity = {
            pairId: credential.pairId,
            tenantId: credential.tenantId,
            operationId: payload.operationId,
          } as DeploymentOperationIdentity;
          return response(
            await authority.verifyGeneration(
              identity,
              payload.generation as DeploymentVerifiedGeneration
            )
          );
        }
        case 'promote':
          return response(
            await authority.promote(payload as unknown as DeploymentOperationIdentity)
          );
        default:
          throw new Error();
      }
    } catch {
      // No database diagnostics, permit identities or tenant existence oracle for unauthenticated callers.
      return response({ error: 'replication_request_rejected' }, 409);
    }
  };
}
