import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  LOGIN_UI_PRESET_KEY_PREFIX,
  LOGIN_UI_PRESET_URL_PREFIX,
  parseLoginUiPresetName,
} from '@authrim/ar-lib-core';
import { detectImageType, logSanitizedError } from './admin-shared';

const PUBLIC_ASSET_MAX_BYTES = 5 * 1024 * 1024;
const PUBLIC_ASSET_KINDS = new Set([
  'logo',
  'background',
  'panel-background',
  'favicon',
  'thumbnail',
  'launcher-background',
]);
/**
 * The owner segment of the platform's own assets (launcher backgrounds every tenant may show). No
 * tenant can have it: tenant IDs start with a lowercase letter or a digit.
 */
export const PLATFORM_ASSET_OWNER = '_platform';
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
    const kind = sanitizeAssetKind(typeof body.kind === 'string' ? body.kind : undefined);

    if (!kind) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Asset kind must be one of: ${[...PUBLIC_ASSET_KINDS].join(', ')}`,
        },
        400
      );
    }
    return await storePublicAsset(c, bucket, tenantId, kind, body.file);
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

/**
 * Uploads a launcher background of the platform's own (`/api/assets/_platform/login-ui/
 * launcher-background/<file>`), for the launchers it shares with tenants. The caller is checked by
 * the platform launchers router this is mounted on.
 */
export async function platformLauncherAssetUploadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const bucket = getPublicAssetsBucket(c.env);
    if (!bucket) {
      return c.json(
        { error: 'server_error', error_description: 'Public assets bucket is not configured' },
        503
      );
    }
    const body = await c.req.parseBody();
    return await storePublicAsset(
      c,
      bucket,
      PLATFORM_ASSET_OWNER,
      'launcher-background',
      body.file
    );
  } catch (error) {
    logSanitizedError('Platform launcher asset upload error', error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to upload public asset' },
      500
    );
  }
}

async function storePublicAsset(
  c: Context<{ Bindings: Env }>,
  bucket: R2Bucket,
  ownerId: string,
  kind: string,
  file: unknown
): Promise<Response> {
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
  const key = buildAssetKey(ownerId, kind, filename);
  await bucket.put(key, arrayBuffer, {
    httpMetadata: {
      contentType: detectedType.mimeType,
    },
  });

  return c.json({
    success: true,
    kind,
    url: `/api/assets/${encodeURIComponent(ownerId)}/login-ui/${kind}/${filename}`,
    contentType: detectedType.mimeType,
    size: file.size,
  });
}

/** Presets are replaced in place by a later setup run: cached for a day, not for ever. */
const PRESET_CACHE_CONTROL = 'public, max-age=86400';
/** Enough for any catalogue of presets; the list stops here rather than paging without end. */
const PRESET_LIST_MAX_PAGES = 10;

export async function servePresetAssetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const preset = parseLoginUiPresetName(
      `${c.req.param('category') ?? ''}/${c.req.param('filename') ?? ''}`
    );
    const bucket = getPublicAssetsBucket(c.env);
    if (!preset || !bucket) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const object = await bucket.get(
      `${LOGIN_UI_PRESET_KEY_PREFIX}${preset.category}/${preset.name}.${preset.extension}`
    );
    if (!object) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', PUBLIC_ASSET_CONTENT_TYPES[preset.extension] ?? 'image/webp');
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', PRESET_CACHE_CONTROL);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(object.body, { headers });
  } catch (error) {
    logSanitizedError('Serve preset asset error', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** The background presets in PUBLIC_ASSETS, each with the path a theme stores to use it. */
export async function adminLoginUiPresetsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const bucket = getPublicAssetsBucket(c.env);
    if (!bucket) return c.json({ presets: [] });

    const presets: { id: string; category: string; name: string; url: string; size: number }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PRESET_LIST_MAX_PAGES; page++) {
      const listed = await bucket.list({ prefix: LOGIN_UI_PRESET_KEY_PREFIX, cursor });
      for (const object of listed.objects) {
        const rest = object.key.slice(LOGIN_UI_PRESET_KEY_PREFIX.length);
        const preset = parseLoginUiPresetName(rest);
        if (!preset) continue;
        presets.push({
          id: `${preset.category}/${preset.name}`,
          category: preset.category,
          name: preset.name,
          url: `${LOGIN_UI_PRESET_URL_PREFIX}${rest}`,
          size: object.size,
        });
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    presets.sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ presets });
  } catch (error) {
    logSanitizedError('Admin preset list error', error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list background presets' },
      500
    );
  }
}
