/**
 * The Login UI background presets: pictures shared by every tenant, placed in the public assets
 * bucket (PUBLIC_ASSETS) so the admin console offers them from the first sign-in. A theme refers
 * to one by its path (`/api/assets/presets/login-ui/backgrounds/<category>/<name>.webp`); the
 * Management worker serves it from `presets/login-ui/backgrounds/<category>/<name>.webp`.
 *
 * The pictures come from the source tree (`packages/ar-management/assets/login-ui-presets/`).
 * Publishing is idempotent: each run puts every picture again, so a changed picture replaces the
 * old one under the same key and every theme that uses it shows the new one.
 */
import { readFile } from 'node:fs/promises';
import {
  assertR2BucketOwnershipForUse,
  putR2Object,
  type DeletionR2Identity,
} from './cloudflare.js';
import { listLoginUiPresetFiles } from './login-ui-presets.js';

export {
  LOGIN_UI_PRESET_KEY_PREFIX,
  LOGIN_UI_PRESET_SOURCE_DIR,
  listLoginUiPresetFiles,
  type LoginUiPresetFile,
} from './login-ui-presets.js';

/** Each picture is a few hundred kB; a larger file is a mistake, not a background. */
const MAX_PRESET_BYTES = 5 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

export interface LoginUiPresetPublicationResult {
  published: string[];
  /** Why nothing was published, when nothing was. */
  skipped?: 'no_presets' | 'no_bucket';
}

/** Puts every preset into the public assets bucket. */
export async function publishLoginUiPresets(input: {
  baseDir: string;
  bucketName?: string;
  upload?: typeof putR2Object;
  verifyBucketOwnership?: () => Promise<void>;
  /**
   * Keeps the keys about to be put (in the lock), before any upload: environment deletion then
   * removes them even after a failed run or once the source tree no longer has them.
   */
  recordObjectKeys?: (keys: readonly string[]) => Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<LoginUiPresetPublicationResult> {
  const files = await listLoginUiPresetFiles(input.baseDir);
  if (files.length === 0) return { published: [], skipped: 'no_presets' };
  const bucketName = input.bucketName?.trim();
  if (!bucketName) return { published: [], skipped: 'no_bucket' };

  await input.verifyBucketOwnership?.();
  await input.recordObjectKeys?.(files.map((file) => file.objectKey));
  const upload = input.upload ?? putR2Object;
  input.onProgress?.(`Publishing ${files.length} Login UI background presets`);

  const published: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const bytes = await readFile(file.path);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PRESET_BYTES) {
        throw new Error(`login_ui_preset_size_invalid:${file.objectKey}`);
      }
      await upload({
        bucketName,
        objectKey: file.objectKey,
        bytes,
        contentType: file.contentType,
      });
      published.push(file.objectKey);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker())
  );
  return { published: published.sort() };
}

/**
 * {@link publishLoginUiPresets} into the environment's PUBLIC_ASSETS bucket as recorded in the
 * lock. The presets are a convenience: a failure is reported through `onWarning` and the
 * deployment goes on (the admin console then says there are no presets yet).
 */
export async function publishLoginUiPresetsToEnvironment(input: {
  baseDir: string;
  environment: string;
  bucket?: DeletionR2Identity;
  /** Saves the keys into the lock's PUBLIC_ASSETS entry (see {@link withR2SetupObjectKeys}). */
  recordObjectKeys: (keys: readonly string[]) => Promise<void>;
  onProgress?: (message: string) => void;
  onWarning?: (message: string) => void;
}): Promise<LoginUiPresetPublicationResult | null> {
  const bucket = input.bucket;
  try {
    return await publishLoginUiPresets({
      baseDir: input.baseDir,
      bucketName: bucket?.name,
      verifyBucketOwnership: bucket
        ? () =>
            assertR2BucketOwnershipForUse({
              ...bucket,
              environment: input.environment,
              binding: 'PUBLIC_ASSETS',
            })
        : undefined,
      recordObjectKeys: input.recordObjectKeys,
      onProgress: input.onProgress,
    });
  } catch (error) {
    input.onWarning?.(
      `Login UI background presets were not published: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
