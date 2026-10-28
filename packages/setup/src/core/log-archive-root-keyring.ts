import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseLogIcebergRootKeyring,
  type LogIcebergRootKeyring,
} from '@authrim/ar-lib-core/services/log-iceberg-keys';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';

const FILE = 'log_archive_root_keyring.json';
const privateOptions = {
  maxBytes: 4096,
  invalidError: 'log_archive_root_keyring_file_invalid',
  permissionsError: 'log_archive_root_keyring_permissions_invalid',
};

/** Extend log-only master history without changing business-object encryption or stable HMAC. */
export async function ensureLogArchiveRootKeyring(
  keysDir: string,
  options: { keyVersion: number; requireExisting?: boolean }
): Promise<void> {
  if (
    !Number.isSafeInteger(options.keyVersion) ||
    !/^[1-9][0-9]{0,8}$/u.test(String(options.keyVersion))
  )
    throw new Error('log_archive_root_key_version_invalid');
  const path = join(keysDir, FILE);
  const lock = join(keysDir, '.log-archive-root-keyring.lock');
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error('log_archive_root_keyring_locked');
  }
  try {
    const root = (
      await readPrivateFileSecurely(join(keysDir, 'object_encryption_root_key.txt'), {
        ...privateOptions,
        maxBytes: 128,
      })
    )
      ?.trim()
      .toLowerCase();
    if (!root || !/^[a-f0-9]{64}$/u.test(root))
      throw new Error('log_archive_current_root_key_required');
    const metadataPath = join(keysDir, 'metadata.json');
    const metadataText = await readPrivateFileSecurely(metadataPath, {
      ...privateOptions,
      maxBytes: 128 * 1024,
      repairLegacyPublicReadPermissions: true,
    });
    const metadata: unknown = metadataText === null ? { files: {} } : JSON.parse(metadataText);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('log_archive_key_metadata_invalid');
    const saved = metadata as { files?: Record<string, unknown> };
    if (
      saved.files !== undefined &&
      (!saved.files || typeof saved.files !== 'object' || Array.isArray(saved.files))
    )
      throw new Error('log_archive_key_metadata_invalid');
    const previousText = await readPrivateFileSecurely(path, privateOptions);
    if (
      previousText === null &&
      (options.requireExisting || saved.files?.logArchiveRootKeyring !== undefined)
    )
      throw new Error('log_archive_root_keyring_missing_restore_original_keys');
    const previous = previousText === null ? null : parseLogIcebergRootKeyring(previousText);
    if (previous && options.keyVersion < previous.current_version)
      throw new Error('log_archive_root_key_version_rollback');
    if (
      previous?.roots[String(options.keyVersion)] !== undefined &&
      previous.roots[String(options.keyVersion)] !== root
    )
      throw new Error('log_archive_root_key_version_conflict');
    const next: LogIcebergRootKeyring = {
      schema_version: 1,
      current_version: options.keyVersion,
      roots: { ...previous?.roots, [String(options.keyVersion)]: root },
    };
    // Validate the complete merged ring before either write; never prune old masters at a limit.
    const encoded = JSON.stringify(next);
    parseLogIcebergRootKeyring(encoded);
    // Record existence first: interruption must never make a lost registry look like first setup.
    saved.files = { ...saved.files, logArchiveRootKeyring: path };
    await writePrivateFileAtomically(metadataPath, JSON.stringify(metadata, null, 2));
    await writePrivateFileAtomically(path, encoded);
  } finally {
    await rmdir(lock);
  }
}
