/**
 * The body size limit of the Admin API: 100 KiB for most routes (enough for a policy or a setting,
 * and it keeps large payloads out), and more where a route takes more by design.
 */
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '@authrim/ar-lib-core';

/**
 * The body of a Mapping Set save: its content is held to 128 KiB by the checks of the version
 * create, and the rest is the envelope. The facade reads its body with the same limit.
 */
export const MAPPING_SET_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;

/** The routes whose body is a Mapping Set. */
export function isMappingSetSavePath(path: string): boolean {
  return (
    path === '/api/admin/identity-mapping/sets' ||
    path.startsWith('/api/admin/identity-mapping/sets/')
  );
}

export function adminBodyLimitMiddleware(
  userImportMaxUploadBytes: number
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const isImportUpload = c.req.path.startsWith('/api/admin/jobs/users/import/upload/');
    const isTenantBackupPart = /^\/api\/admin\/tenant-backups\/uploads\/[^/]+\/parts\/[^/]+$/.test(
      c.req.path
    );
    const isPublicAssetUpload = c.req.path === '/api/admin/assets/login-ui';
    const isMappingSetSave = isMappingSetSavePath(c.req.path);
    const maxSize = isTenantBackupPart
      ? 8 * 1024 * 1024
      : isImportUpload
        ? userImportMaxUploadBytes
        : isPublicAssetUpload
          ? 5 * 1024 * 1024
          : isMappingSetSave
            ? MAPPING_SET_REQUEST_BODY_LIMIT_BYTES
            : 100 * 1024;
    const maxSizeLabel = isTenantBackupPart
      ? '8MB'
      : isImportUpload
        ? '50MB'
        : isPublicAssetUpload
          ? '5MB'
          : isMappingSetSave
            ? '256KB'
            : '100KB';

    return bodyLimit({
      maxSize,
      onError: (ctx) => {
        return ctx.json(
          {
            error: 'payload_too_large',
            message: `Request body exceeds maximum allowed size (${maxSizeLabel})`,
          },
          413
        );
      },
    })(c, next);
  };
}
