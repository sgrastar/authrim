/**
 * Certification profiles (OpenID certification test plans)
 *
 * GET  /api/admin/certification-profiles             - The profiles and the settings each sets
 * POST /api/admin/certification-profiles/:id/apply   - Apply one to the request's tenant
 *
 * Applying a profile saves its values as the tenant's Settings API values and clears the other
 * protocol settings profiles manage, so the tenant inherits those again (a profile replaced the
 * older document's fapi and oidc sections whole). The tenant's older certification profile loses
 * those sections too, so a later run of the one-time import of the older stores does not bring
 * back values the new profile left out.
 *
 * Settings documents are saved one category at a time, without a transaction across them. So
 * everything is read and checked first, and once saved, every managed document must still be the
 * version the apply left: a save in between (another profile, a PATCH) or a failure part way is
 * answered as an error naming what was applied, never as success. Applying a profile is
 * repeatable, so applying it again puts the whole profile in place.
 */

import type { Context } from 'hono';
import {
  buildTenantSystemSettingsKey,
  ConflictError,
  createAuditLogFromContext,
  generateVersion,
  requireDedicatedAdminDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  parseSettingsDocument,
  projectLatestSettingsDocument,
  sanitizeObject,
  settingsParentScopes,
  settingsStorageKey,
  type AdminAuthContext,
  type CategoryName,
  type Env,
  type SettingScope,
  type SettingsPatchResult,
} from '@authrim/ar-lib-core';
import {
  CERTIFICATION_PROFILE_MANAGED_KEYS,
  getCertificationProfile,
  listCertificationProfiles,
} from '../certification-profiles';
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import { runTenantBackupCoveredMutation } from '../tenant-backup-writer';
import { validateCategoryPatch } from './settings-v2/patch-validation';
import { canAccessTenant, getSettingsManager } from './settings-v2';

type AdminContext = Context<{ Bindings: Env }>;

/** The sections of the older document a profile replaced. */
const PROFILE_SECTIONS = ['fapi', 'oidc'];

export function listCertificationProfilesHandler(c: AdminContext) {
  return c.json({ profiles: listCertificationProfiles() });
}

export async function applyCertificationProfileHandler(c: AdminContext) {
  const log = getLogger(c).module('CERTIFICATION_PROFILES');
  const profileId = c.req.param('id') ?? '';
  const profile = getCertificationProfile(profileId);
  if (!profile) {
    return c.json(
      { error: 'not_found', error_description: `Certification profile '${profileId}' not found` },
      404
    );
  }
  const tenantId = getTenantIdFromContext(c);
  const adminAuth = (c.get as (key: string) => unknown)('adminAuth') as
    | AdminAuthContext
    | undefined;
  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json(
      { error: 'forbidden', error_description: 'Cannot modify settings for this tenant' },
      403
    );
  }

  return runTenantBackupCoveredMutation({
    env: c.env,
    tenantId,
    run: async () => {
      // Runtime reads settings from this KV: without it, nothing saved here would apply.
      const settingsKv = c.env.SETTINGS;
      if (!settingsKv) {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Settings storage is not configured; nothing was changed',
          },
          503
        );
      }
      // The tenant's older profile, read first: when it cannot be read nothing is changed.
      const overlayKey = buildTenantSystemSettingsKey(tenantId);
      let overlay: Record<string, unknown> | null;
      try {
        overlay = parseSettingsDocument(await settingsKv.get(overlayKey));
      } catch (error) {
        log.warn('Older certification profile cannot be read', { tenantId }, error as Error);
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description:
              "The tenant's older certification profile cannot be read; nothing was changed",
          },
          503
        );
      }

      // Strict reads: a document that cannot be read stops the apply instead of reading as empty.
      const manager = getSettingsManager(
        c.env,
        c as unknown as Parameters<typeof getSettingsManager>[1],
        true,
        true
      );
      const store = new DatabaseSettingsCanonicalStore(
        requireDedicatedAdminDatabaseAdapter(c.env, 'settings-canonical')
      );
      const scope: SettingScope = { type: 'tenant', id: tenantId };
      const actor = adminAuth?.userId ?? 'unknown';

      // Everything is read and checked before anything is saved.
      type Change = {
        category: CategoryName;
        version: string;
        set: Record<string, unknown>;
        clear: string[];
        context: { parents: SettingScope[] };
      };
      const changes: Change[] = [];
      /** The version each managed document was read at. */
      const read = new Map<string, string | null>();
      const categories = [...CERTIFICATION_PROFILE_MANAGED_KEYS.keys()];
      /** The saved version of each managed document once the profile is in place. */
      let expected: Map<string, string | null>;
      /** The documents left as they were whose copy to KV is still pending. */
      let stale: string[];
      let inheritedPending: string[];
      /** The canonical copy (D1) of the older profile, where there is one. */
      const profileCategory = 'certification-profile';
      let canonical: Awaited<ReturnType<typeof store.load>>;
      try {
        for (const [category, managed] of CERTIFICATION_PROFILE_MANAGED_KEYS) {
          const set = profile.settings[category] ?? {};
          // What the save reads too (the platform's documents), read now.
          const context = { parents: settingsParentScopes(category, scope) };
          const current = await manager.getAll(category, scope, context);
          read.set(category, current.version);
          // Managed settings the profile leaves out: inherited again.
          const clear = managed.filter((key) => !(key in set) && current.sources[key] === 'kv');
          const problem =
            validateCategoryPatch(category, { ifMatch: '', set }) ??
            (manager.validate(category, set).valid ? null : 'invalid value');
          if (problem) throw new Error(`Profile ${profileId} ${category}: ${problem}`);
          if (Object.keys(set).length > 0 || clear.length > 0) {
            changes.push({ category, version: current.version, set, clear, context });
          }
        }
        canonical = await store.load(profileCategory, scope);
        const { documents: before, platformPending } = await store.snapshot(categories, scope);
        // What the tenant inherits must be in effect too: a platform document whose copy to KV
        // is pending would leave runtime inheriting its previous values. Copied now, as the
        // scheduled copy would (the platform's values do not change); one still pending stops
        // the apply.
        inheritedPending = [];
        for (const category of platformPending) {
          const platform: SettingScope = { type: 'platform' };
          const projected = await projectLatestSettingsDocument(
            store,
            settingsKv,
            category,
            platform,
            settingsStorageKey(category, platform)
          );
          if (projected === 'pending') inheritedPending.push(category);
        }
        expected = new Map(
          categories.map((category) => [category, before.get(category)?.version ?? null])
        );
        const changed = new Set(changes.map((change) => change.category));
        stale = categories.filter(
          (category) => !changed.has(category) && before.get(category)?.pending === true
        );
      } catch (error) {
        log.error('Certification profile could not be prepared', { tenantId }, error as Error);
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Settings cannot be read; nothing was changed',
          },
          503
        );
      }

      if (inheritedPending.length > 0) {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: `The platform settings for ${inheritedPending.join(', ')} are not yet in effect; nothing was changed`,
          },
          503
        );
      }

      // A save between the reads above and that snapshot would go unnoticed (a value to clear
      // added, or a document taken as already in place).
      if (categories.some((category) => expected.get(category) !== read.get(category))) {
        return c.json(
          {
            error: 'conflict',
            error_description: 'Settings changed while the profile was read; nothing was changed',
          },
          409
        );
      }

      const results: Record<string, SettingsPatchResult> = {};
      const pending: string[] = [];
      const partial = (status: 409 | 503, description: string) =>
        c.json(
          {
            error: status === 409 ? 'conflict' : 'temporarily_unavailable',
            error_description: `${description}; apply the profile again (applying it is repeatable)`,
            partially_applied: Object.keys(results),
          },
          status
        );
      try {
        for (const change of changes) {
          const result = await manager.patch(
            change.category,
            scope,
            { ifMatch: change.version, set: change.set, clear: change.clear },
            actor,
            {
              ...change.context,
              // A profile is a whole configuration: its values do not depend on the old ones.
              skipDependencyCheck: true,
            }
          );
          results[change.category] = result;
          if (Object.keys(result.rejected).length > 0) {
            log.error('Certification profile values were refused', {
              tenantId,
              category: change.category,
              rejected: Object.keys(result.rejected),
            });
            return partial(503, 'Some profile values were refused');
          }
          expected.set(change.category, result.version);
          // Copied by the save itself; written again at once, KV would refuse it (one write a
          // second per key), so a pending copy is left to applying the profile again.
          if (result.projection === 'pending') pending.push(change.category);
        }
        // A document left as it was may still wait for the copy of an earlier save (a clear an
        // earlier apply could not copy): copied now.
        for (const category of stale) {
          const projected = await projectLatestSettingsDocument(
            store,
            settingsKv,
            category,
            scope,
            settingsStorageKey(category, scope)
          );
          if (projected === 'pending') pending.push(category);
        }
        // Saved, but runtime still reads the previous values of these until they are copied.
        if (pending.length > 0) {
          return partial(503, `Saved, but not yet in effect for ${pending.join(', ')}`);
        }

        // A later run of the import would otherwise save the older profile's values the new
        // profile left out. A canonical copy of it (D1), where there is one, is what its
        // scheduled copy to KV writes.
        const older = canonical ? canonical.data : overlay;
        if (older && PROFILE_SECTIONS.some((section) => section in older)) {
          const removed = sanitizeObject(
            Object.fromEntries(
              PROFILE_SECTIONS.filter((section) => section in older).map((section) => [
                section,
                older[section],
              ])
            )
          );
          const rest = sanitizeObject(
            Object.fromEntries(
              Object.entries(older).filter(([section]) => !PROFILE_SECTIONS.includes(section))
            )
          );
          // Not a Settings API save: recorded first, with what is removed (the tenant inherits
          // those values from the platform afterwards). When it cannot be recorded, nothing is
          // removed, so applying the profile again records and removes it.
          try {
            await createAuditLogFromContext(
              c,
              'settings.certification_profile_sections_removed',
              'settings',
              `tenant:${tenantId}:certification-profile`,
              { scope: 'tenant', scope_id: tenantId, profile: profileId, actor, removed }
            );
          } catch (error) {
            log.error(
              'Older certification profile change could not be recorded',
              { tenantId },
              error as Error
            );
            return partial(503, 'The older certification profile could not be updated');
          }
          // The canonical copy is updated, or its scheduled copy to KV would bring the removed
          // sections back.
          if (canonical) {
            const updated = await store.compareAndSet(profileCategory, scope, canonical.version, {
              data: rest,
              version: generateVersion(rest),
            });
            if (!updated) {
              return partial(409, 'The older certification profile changed while it was updated');
            }
            const projected = await projectLatestSettingsDocument(
              store,
              settingsKv,
              profileCategory,
              scope,
              overlayKey
            );
            if (projected === 'pending') {
              return partial(503, 'The older certification profile is not yet updated in KV');
            }
          } else if (Object.keys(rest).length === 0) {
            await settingsKv.delete(overlayKey);
          } else {
            await settingsKv.put(overlayKey, JSON.stringify(rest));
          }
        }

        // A canonical copy of the older profile whose copy to KV is still pending (a removal an
        // earlier apply saved but could not copy) is copied now: until then, the import reads the
        // removed sections.
        if (canonical) {
          const state = (await store.snapshot([profileCategory], scope)).documents.get(
            profileCategory
          );
          if (
            state?.pending &&
            (await projectLatestSettingsDocument(
              store,
              settingsKv,
              profileCategory,
              scope,
              overlayKey
            )) === 'pending'
          ) {
            return partial(503, 'The older certification profile is not yet updated in KV');
          }
        }

        // Another save in between (another profile, or a PATCH) would leave a mix: the profile
        // is in place only if every managed document is still the version this left, and copied
        // to KV, read as one snapshot.
        const { documents: after, platformPending: platformNotCopied } = await store.snapshot(
          categories,
          scope
        );
        if (
          categories.some(
            (category) => (after.get(category)?.version ?? null) !== expected.get(category)
          )
        ) {
          return partial(409, 'Settings changed while the profile was applied');
        }
        const notCopied = [
          ...categories.filter((category) => after.get(category)?.pending === true),
          ...platformNotCopied.map((category) => `${category} (platform)`),
        ];
        if (notCopied.length > 0) {
          return partial(503, `Saved, but not yet in effect for ${notCopied.join(', ')}`);
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          return partial(409, 'Settings changed while the profile was applied');
        }
        log.error('Certification profile could not be applied', { tenantId }, error as Error);
        return partial(503, 'Settings cannot be saved');
      }

      return c.json({
        profile: { id: profileId, name: profile.name, description: profile.description },
        tenant_id: tenantId,
        results,
      });
    },
  });
}
