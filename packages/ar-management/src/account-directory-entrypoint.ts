import { WorkerEntrypoint } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import {
  ensureDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  createLogger,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryRemovalPublication,
  type Env,
} from '@authrim/ar-lib-core';
import { AccountDirectoryCoordinator } from './account-directory-coordinator';
import { activatePublishedAccountAuthenticationState } from './account-authentication-activation';
import { AccountDirectoryRemovalCoordinator } from './account-directory-removal';
import { AccountCreationOperationRepository } from './account-creation-operation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

export interface AccountDirectoryRpcProps {
  caller: 'ar-management';
  environmentId: string;
  audience: 'authrim-account-directory-v1';
}

function authorized(props: AccountDirectoryRpcProps, env: Env): string {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    props?.caller !== 'ar-management' ||
    props.audience !== 'authrim-account-directory-v1' ||
    typeof environmentId !== 'string' ||
    props.environmentId !== environmentId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(environmentId)
  ) {
    throw new Error('account_directory_rpc_caller_unauthorized');
  }
  return environmentId;
}

function d1Binding(env: Env, bindingRef: string, errorCode: string): D1Database {
  const binding = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!binding || typeof binding !== 'object') throw new Error(errorCode);
  const candidate = binding as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error(errorCode);
  }
  return binding as D1Database;
}

function tenantCoreBinding(
  env: Env,
  publication: Pick<AccountDirectoryPublication, 'routeProjection'>
): D1Database {
  const targets = publication.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_core/users'
  );
  if (targets.length !== 1) throw new Error('account_directory_source_route_invalid');
  return d1Binding(env, targets[0].bindingRef, 'account_directory_source_binding_unavailable');
}

const EXPOSED_ERROR =
  /^(account_directory_(rpc_caller_unauthorized|source_route_invalid|source_binding_unavailable)|directory_[a-z0-9_]+|invalid_[a-z0-9_]+|lookup_registry_[a-z0-9_]+|control_plane_sensitive_[a-z0-9_:.$-]+)$/u;
const SAFE_DIAGNOSTIC_ERROR =
  /^(account_creation_[a-z0-9_]+|account_directory_[a-z0-9_]+|directory_[a-z0-9_]+|invalid_[a-z0-9_]+|lookup_registry_[a-z0-9_]+|control_plane_sensitive_[a-z0-9_:.$-]+)$/u;

function logDirectoryFailure(action: 'publish' | 'remove', error: unknown): void {
  const errorCode =
    error instanceof Error && SAFE_DIAGNOSTIC_ERROR.test(error.message)
      ? error.message
      : 'account_directory_internal_error';
  createLogger().module('ACCOUNT-DIRECTORY').error('Account directory operation failed', {
    action,
    errorCode,
  });
}

export class AccountDirectoryEntrypoint extends WorkerEntrypoint<Env, AccountDirectoryRpcProps> {
  async publishAccountDirectory(input: unknown): Promise<AccountDirectoryPublishResult> {
    try {
      const environmentId = authorized(this.ctx.props, this.env);
      const publication = await validateAccountDirectoryPublication(
        input as AccountDirectoryPublication
      );
      if (!this.env.TENANT_RUNTIME_REGISTRY) {
        throw new Error('lookup_registry_snapshot_unavailable');
      }
      const publicJwks = this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS;
      if (!publicJwks) throw new Error('lookup_registry_public_jwks_unavailable');
      const lookupForBucket = await createLookupBucketWriteResolver(this.env);
      const tenantCore = tenantCoreBinding(this.env, publication);
      const coordinator = new AccountDirectoryCoordinator({
        tenantCore,
        lookupForBucket,
        now: () => Math.floor(Date.now() / 1000),
        onAccountActivated: async (activatedPublication, now) => {
          await activatePublishedAccountAuthenticationState(
            this.env,
            tenantCore,
            activatedPublication,
            now
          );
          const operationRepository = new AccountCreationOperationRepository(
            await resolveAuthCorePersistenceAdapterFromEnv(
              this.env,
              'account-directory-operation',
              { tenantId: activatedPublication.tenantId }
            )
          );
          await operationRepository.recordDirectoryOutcome({
            publication: activatedPublication,
            outcome: 'succeeded',
            now,
            lifecycleEventAdapter: ensureDatabaseAdapter(
              tenantCore,
              'account-directory-lifecycle-events'
            ),
          });
        },
      });
      return await coordinator.publish(publication);
    } catch (error) {
      logDirectoryFailure('publish', error);
      if (error instanceof Error && EXPOSED_ERROR.test(error.message)) {
        throw new Error(error.message);
      }
      throw new Error('account_directory_internal_error');
    }
  }

  async removeAccountDirectory(input: unknown): Promise<AccountDirectoryPublishResult> {
    try {
      authorized(this.ctx.props, this.env);
      const publication = await validateAccountDirectoryRemovalPublication(
        input as AccountDirectoryRemovalPublication
      );
      if (!this.env.TENANT_RUNTIME_REGISTRY) {
        throw new Error('lookup_registry_snapshot_unavailable');
      }
      if (!this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS) {
        throw new Error('lookup_registry_public_jwks_unavailable');
      }
      const coordinator = new AccountDirectoryRemovalCoordinator({
        tenantCore: tenantCoreBinding(this.env, publication),
        lookupForBucket: await createLookupBucketWriteResolver(this.env),
        now: () => Math.floor(Date.now() / 1000),
      });
      return await coordinator.remove(publication);
    } catch (error) {
      logDirectoryFailure('remove', error);
      if (error instanceof Error && EXPOSED_ERROR.test(error.message)) {
        throw new Error(error.message);
      }
      throw new Error('account_directory_internal_error');
    }
  }
}
