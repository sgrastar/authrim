/**
 * `authrim admin recover-second-factor --env <env> --admin <email>`
 *
 * The last-resort recovery of an admin's step-up second factors, on the Cloudflare access this
 * machine has to the environment (see core/admin-second-factor-recovery.ts). It is for an admin
 * who lost every second factor when no other administrator can confirm a recovery request.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { input as promptInput } from '@inquirer/prompts';
import chalk from 'chalk';
import { AuthrimConfigSchema } from '../../core/config.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import {
  AdminSecondFactorRecoveryError,
  normalizeRecoveryRequest,
  recoverAdminSecondFactor,
  type AdminSecondFactorRecoveryResult,
} from '../../core/admin-second-factor-recovery.js';
import { getDeployKeysDirHint } from './deploy.js';

export interface AdminRecoverSecondFactorOptions {
  env?: string;
  admin?: string;
  tenant?: string;
  reason?: string;
  keysDir?: string;
  yes?: boolean;
}

const MANUAL_PROCEDURE_DOC = 'docs/operations/admin-second-factor-last-resort-recovery.md';

/** What the command will do, shown before it asks for confirmation. */
export function describeRecovery(env: string, email: string, tenantId?: string): string[] {
  return [
    chalk.bold.red('Last-resort recovery of an admin’s step-up second factors'),
    '',
    `  Environment: ${env}`,
    `  Admin:       ${email}${tenantId ? ` (tenant ${tenantId})` : ''}`,
    '',
    'This uses your Cloudflare access to the environment and cannot be undone:',
    '  - every security key and Keyring credential the admin registered for step-up is revoked',
    '    (they can never be registered again),',
    '  - all of the admin’s sessions are ended, and an open recovery request is cancelled,',
    '  - for a limited time (24 hours unless configured otherwise) the admin may register a new',
    '    second factor after signing in with their passkey alone.',
    'The admin and every active administrator are emailed, and the audit log records it.',
  ];
}

/** The summary printed after the API answered. */
export function describeRecoveryResult(result: AdminSecondFactorRecoveryResult): string[] {
  const lines = [
    chalk.green('✔ Second factors reset'),
    `  Admin:                ${result.admin.email} (tenant ${result.admin.tenantId})`,
    `  Revoked factors:      ${result.revokedSecondFactors}`,
    `  Ended sessions:       ${result.endedSessions}`,
    `  Cancelled requests:   ${result.cancelledRecoveryRequests}`,
    `  Re-enrolment until:   ${new Date(result.reenrollUntil).toISOString()}`,
    '',
    'Next: the admin signs in to the Admin console with their passkey and registers a new',
    'security key or Keyring credential (My account → Security keys) before the window closes.',
  ];
  if (!result.notices.emailed) {
    lines.push(
      '',
      chalk.yellow(
        '⚠ Not every notification email could be sent. Tell the other administrators yourself.'
      )
    );
  }
  if (!result.auditLogged) {
    lines.push(chalk.yellow('⚠ The audit log entry could not be written. Record this yourself.'));
  }
  return lines;
}

function explainFailure(env: string, error: unknown): string {
  if (error instanceof AdminSecondFactorRecoveryError) {
    switch (error.code) {
      case 'not_found':
        return 'No administrator has this email in the environment.';
      case 'admin_ambiguous': {
        const tenants = Array.isArray(error.detail.tenant_ids)
          ? error.detail.tenant_ids.join(', ')
          : '';
        return `Administrators in several tenants have this email${tenants ? ` (${tenants})` : ''}: pass --tenant <id>.`;
      }
      case 'admin_not_active':
        return 'The administrator is not active.';
      case 'target_not_human_admin':
        return 'The target is a machine principal, which has no second factors.';
      default:
        return `The Admin API refused the recovery (${error.status} ${error.code}). Deploy a release that has the last-resort recovery API, or use the manual procedure in ${MANUAL_PROCEDURE_DOC}.`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith('environment_not_found:') ||
    message.startsWith('environment_lock_not_found:')
  ) {
    return `No lock file for environment "${env}" on this machine. Use the manual procedure in ${MANUAL_PROCEDURE_DOC}.`;
  }
  return message;
}

export async function adminRecoverSecondFactorCommand(
  options: AdminRecoverSecondFactorOptions
): Promise<void> {
  const env = options.env;
  if (!env || !options.admin) {
    console.error(chalk.red('Both --env and --admin are required.'));
    process.exitCode = 1;
    return;
  }
  let request;
  try {
    request = normalizeRecoveryRequest({
      email: options.admin,
      ...(options.tenant ? { tenantId: options.tenant } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
    return;
  }

  const baseDir = findAuthrimBaseDir(process.cwd());
  const paths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(paths.config)) {
    console.error(chalk.red(explainFailure(env, new Error(`environment_not_found:${env}`))));
    process.exitCode = 1;
    return;
  }
  const config = AuthrimConfigSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')));
  const keysDir = resolveDownstreamIntrospectionKeysDir({
    env,
    rootDir: baseDir,
    keysDir: getDeployKeysDirHint({
      baseDir,
      explicitKeysDir: options.keysDir,
      configuredKeysDir: config.keys.secretsPath,
    }),
    keysBaseDir: process.cwd(),
  });

  for (const line of describeRecovery(env, request.email, request.tenantId)) console.log(line);
  console.log('');
  if (!options.yes) {
    // Typing the address, not a yes/no, so the account is the one meant.
    const typed = await promptInput({
      message: `Type the admin's email (${request.email}) to confirm:`,
    });
    if (typed.trim().toLowerCase() !== request.email) {
      console.log(chalk.yellow('Cancelled: the email did not match.'));
      return;
    }
  }

  try {
    const result = await recoverAdminSecondFactor({
      baseDir,
      env,
      keysDir,
      ...request,
      onProgress: (message) => console.log(chalk.gray(message)),
    });
    console.log('');
    for (const line of describeRecoveryResult(result)) console.log(line);
  } catch (error) {
    console.error(chalk.red(`✖ ${explainFailure(env, error)}`));
    process.exitCode = 1;
  }
}
