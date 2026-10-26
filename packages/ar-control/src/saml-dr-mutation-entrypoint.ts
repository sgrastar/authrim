import { WorkerEntrypoint } from 'cloudflare:workers';
import { controlTenantMutationPermit } from './tenant-backup-mutation-permits';
import type { ControlEnv } from './types';
import {
  runSamlDrCoveredOperation,
  type SamlDrWriterEnv,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';

export const SAML_DR_MUTATION_CALLERS = [
  'ar-auth',
  'ar-saml',
  'ar-lib-core',
  'ar-management',
  'ar-userinfo',
  'ar-token',
  'ar-bridge',
  'ar-async',
  'ar-policy',
  'ar-vc',
  'ar-agent-access',
  'ar-plugin-runner',
] as const;

const localEnvironments = new WeakMap<ControlEnv, ControlEnv & SamlDrWriterEnv>();

/** Control's own writers use the same durable gate without making a recursive service call. */
export function runControlSamlDrOperation<T>(
  env: ControlEnv,
  operation: (env: ControlEnv) => Promise<T>
): Promise<T> {
  if (env.ENABLE_SAML_DR_EXPORT !== 'true') return operation(env);
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(environmentId) ||
    !env.CONTROL_DB
  )
    return Promise.reject(new Error('saml_dr_writer_unavailable'));
  let local = localEnvironments.get(env);
  if (!local) {
    const permit = (request: unknown, action: 'acquire' | 'complete') =>
      controlTenantMutationPermit({
        database: env.CONTROL_DB,
        environmentId,
        caller: 'ar-control',
        request,
        action,
        scope: 'environment',
        now: Date.now(),
      });
    local = {
      ...env,
      SAML_DR_MUTATION_CONTROL: {
        async acquireEnvironmentBackupMutationPermit(request) {
          const result = await permit(request, 'acquire');
          if (!result) throw new Error('saml_dr_writer_unavailable');
          return result;
        },
        async completeEnvironmentBackupMutationPermit(request) {
          await permit(request, 'complete');
        },
      },
    };
    localEnvironments.set(env, local);
    localEnvironments.set(local, local);
  }
  return runSamlDrCoveredOperation(local, undefined, (covered) => {
    localEnvironments.set(covered, local);
    return operation(covered);
  });
}

export interface SamlDrMutationProps {
  caller: (typeof SAML_DR_MUTATION_CALLERS)[number];
  audience: 'authrim-saml-dr-mutation-v1';
  environmentId: string;
}

/** Narrow admission binding: it cannot start backups or operate Control resources. */
export class SamlDrMutationEntrypoint extends WorkerEntrypoint<ControlEnv, SamlDrMutationProps> {
  fetch(): Response {
    return new Response('Not Found', { status: 404 });
  }

  async #permit(request: unknown, action: 'acquire' | 'complete') {
    const props = this.ctx.props;
    if (
      !props ||
      !(SAML_DR_MUTATION_CALLERS as readonly string[]).includes(props.caller) ||
      props.audience !== 'authrim-saml-dr-mutation-v1' ||
      typeof props.environmentId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(props.environmentId) ||
      this.env.AUTHRIM_ENVIRONMENT_NAME !== props.environmentId
    )
      throw new Error('control_rpc_caller_unauthorized');
    try {
      return await controlTenantMutationPermit({
        database: this.env.CONTROL_DB,
        environmentId: props.environmentId,
        caller: props.caller,
        request,
        action,
        scope: 'environment',
        now: Date.now(),
      });
    } catch {
      throw new Error('saml_dr_writer_unavailable');
    }
  }

  async acquireEnvironmentBackupMutationPermit(input: unknown): Promise<{ admitted: boolean }> {
    const result = await this.#permit(input, 'acquire');
    if (!result) throw new Error('saml_dr_writer_unavailable');
    return result;
  }

  async completeEnvironmentBackupMutationPermit(input: unknown): Promise<void> {
    await this.#permit(input, 'complete');
  }
}
