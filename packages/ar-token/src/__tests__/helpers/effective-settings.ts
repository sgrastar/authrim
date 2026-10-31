/**
 * The Settings API values a category resolves to when the platform has saved the values of an
 * older `system_settings` document (as the one-time import saves them), over env and the catalog
 * defaults, for tests that describe settings by that document.
 */
import { ALL_CATEGORY_META, createSettingsManager, type CategoryMeta } from '@authrim/ar-lib-core';
import { systemSettingsFieldValues } from '@authrim/ar-lib-core/utils/system-settings-fields';

export async function settingsFromSystemSettings(
  env: unknown,
  systemSettings: Record<string, unknown> | null,
  category: string
): Promise<Record<string, unknown>> {
  const manager = createSettingsManager({
    env: (env ?? {}) as Record<string, string | undefined>,
    kv: null,
    cacheTTL: 0,
  });
  for (const meta of Object.values(ALL_CATEGORY_META))
    manager.registerCategory(meta as CategoryMeta);
  const { values } = await manager.getAll(category, { type: 'platform' });
  return { ...values, ...systemSettingsFieldValues(systemSettings, category) };
}
