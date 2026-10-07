/**
 * One short-lived administrative session against the running local issuer.
 *
 * Setup registers its machine principal in DB_ADMIN, performs the tasks below through the same
 * Admin API a person would use, and removes the principal again.
 */

import { randomUUID } from 'node:crypto';
import type { AuthrimConfig } from '../config.js';
import { cleanupSetupMachineAccessInD1, ensureSetupMachineAccessInD1 } from '../cloudflare.js';
import { ensureLoginUiClient, resolveAdminBearerToken } from '../login-ui-client.js';
import {
  patchTenantSettings,
  readTenantSettings,
  type TenantSettingsTarget,
} from '../generated-settings-v2.js';
import { resolveLoginUiExecutionOrigin } from '../url-config.js';
import { buildLocalLock } from './environment.js';
import { createLocalTarget } from './data.js';
import type { LocalEnvironmentPaths } from './paths.js';

/**
 * Sign-in methods the local log notifier makes usable: email codes need a channel to deliver on.
 * Passkeys are on by default.
 */
export const LOCAL_AUTHENTICATION_METHOD_SETTINGS: Readonly<Record<string, boolean>> = {
  'authentication-methods.email_otp.login_enabled': true,
  'authentication-methods.email_otp.signup_enabled': true,
  'authentication-methods.email_otp.reauth_enabled': true,
  'authentication-methods.email_otp.account_link_enabled': true,
};

export interface LocalAdminSessionResult {
  loginUiClientId: string;
}

export async function runLocalAdminSession(input: {
  env: string;
  config: AuthrimConfig;
  paths: LocalEnvironmentPaths;
  issuer: string;
  onProgress?: (message: string) => void;
}): Promise<LocalAdminSessionResult> {
  const target = createLocalTarget(input.paths);
  const adminDatabase = buildLocalLock(input.env).d1.DB_ADMIN!.id;
  const tenantId = input.config.tenant.name;
  const machine = await ensureSetupMachineAccessInD1(
    input.env,
    input.config,
    input.paths.keys,
    undefined,
    { databaseIdentifier: adminDatabase, target }
  );
  if (!machine.success) {
    throw new Error(`Setup machine access bootstrap failed: ${machine.error ?? 'unknown error'}`);
  }
  try {
    input.onProgress?.('Ensuring the Login UI OAuth client...');
    const loginUiUrl = resolveLoginUiExecutionOrigin(input.config, { env: input.env });
    const clientRequest = {
      apiBaseUrl: input.issuer,
      loginUiUrl,
      keysDir: input.paths.keys,
      tenantId,
      retryDelayMs: 500,
      maxRetries: 5,
    };
    let client = await ensureLoginUiClient(clientRequest);
    if (!client.success) {
      // The server replays the stored answer for a repeated Idempotency-Key, including a
      // failure. A new key makes the retry a new request instead of replaying the old failure.
      client = await ensureLoginUiClient({ ...clientRequest, idempotencyKeySalt: randomUUID() });
    }
    if (!client.success || !client.clientId) {
      throw new Error(`Login UI client creation failed: ${client.error ?? 'unknown error'}`);
    }

    input.onProgress?.('Enabling email-code sign-in (codes are written to the Worker log)...');
    const token = await resolveAdminBearerToken({
      apiBaseUrl: input.issuer,
      keysDir: input.paths.keys,
      tenantId,
    });
    const settings: TenantSettingsTarget = {
      baseUrl: input.issuer,
      adminSecret: token,
      tenantId,
      category: 'authentication-methods',
    };
    const current = await readTenantSettings(settings);
    const pending = Object.entries(LOCAL_AUTHENTICATION_METHOD_SETTINGS).filter(
      ([key, value]) => current.values[key] !== value
    );
    if (pending.length > 0) {
      await patchTenantSettings(settings, {
        ifMatch: current.version,
        set: Object.fromEntries(pending),
      });
    }
    return { loginUiClientId: client.clientId };
  } finally {
    await cleanupSetupMachineAccessInD1(input.env, input.paths.keys, undefined, {
      databaseIdentifier: adminDatabase,
      target,
    });
  }
}
