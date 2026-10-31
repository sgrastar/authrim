export interface BackupSettingField {
  category: string;
  key: string;
  type: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Extract definition shapes only. Defaults, environment values and secrets are not emitted. */
export function inspectBackupSettingFields(metadata: unknown): BackupSettingField[] {
  if (!record(metadata)) throw new Error('backup_settings_metadata_invalid');
  const fields: BackupSettingField[] = [];
  for (const [category, definition] of Object.entries(metadata)) {
    if (!record(definition) || !record(definition.settings)) {
      throw new Error('backup_settings_metadata_invalid');
    }
    for (const [key, setting] of Object.entries(definition.settings)) {
      if (!record(setting) || setting.key !== key || typeof setting.type !== 'string') {
        throw new Error('backup_settings_metadata_invalid');
      }
      fields.push({ category, key, type: setting.type });
    }
  }
  if (fields.length === 0) throw new Error('backup_settings_metadata_empty');
  return fields;
}

export async function inventoryBackupSettings(): Promise<BackupSettingField[]> {
  // A fixed, trusted source module, never a path from a backup or a deployed environment.
  // Load dynamically so this Node CLI does not compile the Worker-global dependency graph.
  const metadataUrl = new URL(
    '../../packages/ar-lib-core/src/types/settings/index.ts',
    import.meta.url
  );
  const module: unknown = await import(metadataUrl.href);
  if (!record(module)) throw new Error('backup_settings_metadata_invalid');
  return inspectBackupSettingFields(module.ALL_CATEGORY_META);
}
