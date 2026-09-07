import type { D1Database } from '@cloudflare/workers-types';
import type {
  AccountEventInstallation,
  ResolveAccountEventInstallationsInput,
} from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const CAPABILITY = 'hook.account.lifecycle' as const;
const MAX_INSTALLATIONS_PER_TENANT = 32;

interface InstallationRow {
  installation_id: string;
}

export class D1AccountEventInstallationResolver {
  constructor(private readonly db: D1Database) {}

  async resolve(input: ResolveAccountEventInstallationsInput): Promise<AccountEventInstallation[]> {
    if (!SAFE_ID.test(input.tenantId) || input.eventType !== 'account.created') {
      throw new Error('plugin_sync_account_event_input_invalid');
    }
    if (typeof this.db.withSession !== 'function') {
      throw new Error('plugin_sync_account_event_d1_session_required');
    }
    const result = await this.db
      .withSession('first-primary')
      .prepare(
        `SELECT installation.installation_id
           FROM plugin_runner_installations installation
           LEFT JOIN plugin_runner_dynamic_worker_artifacts artifact
             ON artifact.installation_id = installation.installation_id
            AND artifact.plugin_id = installation.plugin_id AND artifact.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_releases release
             ON release.plugin_id = artifact.plugin_id
            AND release.version_digest = artifact.version_digest AND release.state = 'published'
           LEFT JOIN plugin_runner_dynamic_worker_manifests manifest
             ON manifest.plugin_id = installation.plugin_id AND manifest.state = 'active'
           LEFT JOIN plugin_runner_dynamic_worker_hook_policies dynamic_policy
             ON dynamic_policy.plugin_id = installation.plugin_id
            AND dynamic_policy.version_digest = artifact.version_digest
            AND dynamic_policy.capability = ?
           LEFT JOIN plugin_runner_hook_policies builtin_policy
             ON builtin_policy.plugin_id = installation.plugin_id
            AND builtin_policy.capability = ?
          WHERE installation.tenant_id = ? AND installation.state = 'enabled'
            AND ((installation.backend_kind = 'dynamic_worker'
                  AND release.version_digest IS NOT NULL
                  AND manifest.plugin_id IS NOT NULL
                  AND dynamic_policy.capability IS NOT NULL)
              OR (installation.backend_kind = 'in_process'
                  AND builtin_policy.capability IS NOT NULL))
          ORDER BY installation.installation_id
          LIMIT ?`
      )
      .bind(CAPABILITY, CAPABILITY, input.tenantId, MAX_INSTALLATIONS_PER_TENANT + 1)
      .all<InstallationRow>();
    const rows = result.results ?? [];
    if (rows.length > MAX_INSTALLATIONS_PER_TENANT) {
      throw new Error('plugin_sync_account_event_installation_limit');
    }
    return rows.map((row) => {
      if (!SAFE_ID.test(row.installation_id)) {
        throw new Error('plugin_sync_account_event_installation_invalid');
      }
      return { installationId: row.installation_id, capability: CAPABILITY };
    });
  }
}
