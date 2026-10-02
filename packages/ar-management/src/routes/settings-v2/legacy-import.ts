/**
 * The one-time import of the older settings stores into the Settings API (platform admins).
 *
 * - GET  /api/admin/platform/settings/legacy-import: its state, and what a run would write now
 *   (a preview: nothing is written).
 * - POST /api/admin/platform/settings/legacy-import:
 *   - `{ "dryRun": false }` runs a step (an import that needs attention starts over);
 *   - `{ "acceptRejections": true }` completes an import that needs attention, accepting the
 *     refused values as they are;
 *   - otherwise a preview. A completed import is not run again.
 *
 * The scheduler runs it on its own, a step a minute; see `legacy-settings-import.ts`.
 */

import { Hono, type Context } from 'hono';
import { createLogger, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';
import { LegacyImportStateError, runLegacySettingsImport } from '../../legacy-settings-import';
import { runTenantBackupCoveredMutation } from '../../tenant-backup-writer';

const log = createLogger().module('LEGACY_SETTINGS_IMPORT_API');

type ImportContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const legacyImport = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();

const PLATFORM_ADMIN_ROLES = ['super_admin', 'system_admin'];

function isPlatformAdmin(c: ImportContext): boolean {
  const roles = c.get('adminAuth')?.roles ?? [];
  return roles.some((role) => PLATFORM_ADMIN_ROLES.includes(role));
}

async function respond(c: ImportContext, mode: 'dry_run' | 'run' | 'accept_rejections') {
  try {
    const report = await runLegacySettingsImport(c.env, {
      mode,
      actor: c.get('adminAuth')?.userId ?? 'unknown',
      trigger: 'admin',
    });
    return c.json(report);
  } catch (error) {
    if (error instanceof LegacyImportStateError) {
      return c.json({ error: 'conflict', message: error.message }, 409);
    }
    // A store or document that cannot be read, or a save that conflicted: the import keeps the
    // position of the last page it finished, and a later step goes on from there.
    log.warn('Settings import did not complete', {
      error: error instanceof Error ? error.name : 'Unknown',
    });
    return c.json(
      {
        error: 'temporarily_unavailable',
        message: 'The settings could not be read or saved; try again later',
      },
      503
    );
  }
}

async function run(c: ImportContext, mode: 'dry_run' | 'run' | 'accept_rejections') {
  if (!isPlatformAdmin(c)) {
    return c.json({ error: 'forbidden', message: 'Requires a platform admin' }, 403);
  }
  if (mode === 'dry_run') return respond(c, mode);
  // Writes are admitted like every settings write, so they wait while a backup or restore holds
  // them (the worker's POST entry admits them too; this keeps the route safe however it is
  // mounted).
  return runTenantBackupCoveredMutation({
    env: c.env,
    scope: 'environment',
    run: () => respond(c, mode),
  });
}

legacyImport.get('/platform/settings/legacy-import', (c) => run(c, 'dry_run'));

legacyImport.post('/platform/settings/legacy-import', async (c) => {
  let body: unknown = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return c.json({ error: 'bad_request', message: 'Body must be JSON' }, 400);
  }
  const request = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (request.acceptRejections === true) return run(c, 'accept_rejections');
  return run(c, request.dryRun === false ? 'run' : 'dry_run');
});

export default legacyImport;
