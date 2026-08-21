import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse, getTenantIdFromContext } from '@authrim/ar-lib-core';
import { detectImageType, logSanitizedError } from './admin-shared';

const PUBLIC_ASSET_MAX_BYTES = 5 * 1024 * 1024;
const PUBLIC_ASSET_KINDS = new Set([
  'logo',
  'background',
  'panel-background',
  'favicon',
  'thumbnail',
]);
const PUBLIC_ASSET_CONTENT_TYPES: Record<string, string> = {
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function getPublicAssetsBucket(env: Env): R2Bucket | null {
  return env.PUBLIC_ASSETS ?? null;
}

function sanitizeAssetKind(value: string | undefined): string | null {
  if (!value || !PUBLIC_ASSET_KINDS.has(value)) return null;
  return value;
}

function sanitizeAssetFilename(
  value: string | undefined
): { filename: string; contentType: string } | null {
  if (!value || !/^[A-Za-z0-9._-]+\.(?:gif|ico|jpe?g|png|webp)$/u.test(value)) {
    return null;
  }
  const extension = value.split('.').pop()?.toLowerCase();
  const contentType = extension ? PUBLIC_ASSET_CONTENT_TYPES[extension] : null;
  return contentType ? { filename: value, contentType } : null;
}

function buildAssetKey(tenantId: string, kind: string, filename: string): string {
  return `public/${tenantId}/login-ui/${kind}/${filename}`;
}

export async function servePublicAssetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = c.req.param('tenantId')!;
    const kind = sanitizeAssetKind(c.req.param('kind'));
    const file = sanitizeAssetFilename(c.req.param('filename'));
    if (!kind || !file || !/^[a-zA-Z0-9_-]{1,128}$/u.test(tenantId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const bucket = getPublicAssetsBucket(c.env);
    if (!bucket) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const object = await bucket.get(buildAssetKey(tenantId, kind, file.filename));
    if (!object) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', file.contentType);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('x-content-type-options', 'nosniff');

    return new Response(object.body, { headers });
  } catch (error) {
    logSanitizedError('Serve public asset error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminPublicAssetUploadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const bucket = getPublicAssetsBucket(c.env);
    if (!bucket) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Public assets bucket is not configured',
        },
        503
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.parseBody();
    const file = body.file;
    const kind = sanitizeAssetKind(typeof body.kind === 'string' ? body.kind : undefined);

    if (!kind) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'Asset kind must be one of: logo, background, panel-background, favicon, thumbnail',
        },
        400
      );
    }
    if (!file || !(file instanceof File)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Image file is required',
        },
        400
      );
    }
    if (file.size > PUBLIC_ASSET_MAX_BYTES) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File size exceeds 5MB limit',
        },
        400
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const detectedType = detectImageType(bytes);
    if (!detectedType) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'File content does not appear to be a valid raster image',
        },
        400
      );
    }

    const filename = `${crypto.randomUUID()}.${detectedType.extension}`;
    const key = buildAssetKey(tenantId, kind, filename);
    await bucket.put(key, arrayBuffer, {
      httpMetadata: {
        contentType: detectedType.mimeType,
      },
    });

    return c.json({
      success: true,
      kind,
      url: `/api/assets/${encodeURIComponent(tenantId)}/login-ui/${kind}/${filename}`,
      contentType: detectedType.mimeType,
      size: file.size,
    });
  } catch (error) {
    logSanitizedError('Admin public asset upload error', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to upload public asset',
      },
      500
    );
  }
}
