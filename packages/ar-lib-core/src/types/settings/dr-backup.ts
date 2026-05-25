/**
 * DR Backup Settings Category
 *
 * Tenant-scoped destination selection for disaster-recovery backup artifacts.
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface DRBackupSettings {
  /** Storage destination ID used for DR backup artifacts */
  'dr-backup.storage_destination_id': string;
}

export const DR_BACKUP_SETTINGS_META: Record<keyof DRBackupSettings, SettingMeta> = {
  'dr-backup.storage_destination_id': {
    key: 'dr-backup.storage_destination_id',
    type: 'string',
    default: '',
    label: 'Storage Destination',
    description: 'Storage destination used for DR backup artifacts',
    visibility: 'admin',
  },
};

export const DR_BACKUP_CATEGORY_META: CategoryMeta = {
  category: 'dr-backup',
  label: 'DR Backup',
  description: 'Disaster recovery backup destination settings',
  settings: DR_BACKUP_SETTINGS_META,
};

export const DR_BACKUP_DEFAULTS: DRBackupSettings = {
  'dr-backup.storage_destination_id': '',
};
