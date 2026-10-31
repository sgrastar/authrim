import type { Env } from '@authrim/ar-lib-core';
import {
  buildSAMLLocalSigningSecretDRBundle,
  restoreSAMLLocalSigningSecretDRBundle,
  validateSAMLLocalSigningSecretDRBundle,
  verifySAMLLocalSigningSecretDRBundle,
} from '@authrim/ar-saml/src/admin/local-signing-dr-bundle';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { encodeSamlLocalSigningBackupRow } from './tenant-backup-phase4-record-datasets';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

async function* capture(env: Env, context: AdapterContext): AsyncIterable<Uint8Array> {
  context.context.signal.throwIfAborted();
  const tenantId = context.context.lease.tenantId;
  const bundle = await buildSAMLLocalSigningSecretDRBundle(env, tenantId);
  context.context.signal.throwIfAborted();
  yield encodeSamlLocalSigningBackupRow(tenantId, bundle);
}

/** Production SAML port reusing the existing local-signing DR implementation. */
export function createTenantBackupSamlPorts(env: Env) {
  return {
    saml: createEncryptedTenantBackupRecordSnapshotPort({
      env,
      resourceId: 'saml-local-signing:key-manager',
      assertSource: async () => {},
      capture: (context) => capture(env, context),
    }),
    validateSamlBundle: async (bundle: unknown, tenantId: string): Promise<void> => {
      validateSAMLLocalSigningSecretDRBundle(bundle, tenantId);
    },
    async importSamlBundle(
      context: { lease: { tenantId: string }; signal: AbortSignal },
      bundle: unknown
    ): Promise<void> {
      context.signal.throwIfAborted();
      await restoreSAMLLocalSigningSecretDRBundle(env, context.lease.tenantId, bundle);
      context.signal.throwIfAborted();
    },
    async verifySamlBundle(
      context: { lease: { tenantId: string }; signal: AbortSignal },
      bundle: unknown
    ): Promise<boolean> {
      context.signal.throwIfAborted();
      const verified = await verifySAMLLocalSigningSecretDRBundle(
        env,
        context.lease.tenantId,
        bundle
      );
      context.signal.throwIfAborted();
      return verified;
    },
  };
}
