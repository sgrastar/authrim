import { DurableObject } from 'cloudflare:workers';
import type {
  SAMLMetadataBatchCreateResult,
  SAMLMetadataBatchStatusResponse,
  SAMLMetadataKeywordFacet,
  SAMLMetadataEntitySummary,
  SAMLMetadataVerificationSummary,
} from '../types/saml';
import type { Env } from '../types/env';

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const CHUNK_SIZE = 60 * 1024;

export interface SAMLAggregatePreviewState {
  previewId: string;
  tenantId: string;
  metadataXml: string;
  metadataUrl?: string;
  entities: SAMLMetadataEntitySummary[];
  verification: SAMLMetadataVerificationSummary;
  createdAt: number;
  expiresAt: number;
}

interface StoredPreviewManifest {
  previewId: string;
  tenantId: string;
  metadataUrl?: string;
  verification: SAMLMetadataVerificationSummary;
  createdAt: number;
  expiresAt: number;
  metadataXmlChunks: number;
  entitiesChunks: number;
}

/**
 * Short-lived SAML aggregate metadata preview and batch progress store.
 *
 * The store is intentionally temporary. It keeps large aggregate XML in chunks so callers can
 * preview/search the aggregate, then create providers from selected EntityDescriptor entries.
 */
export class SAMLAggregateMetadataStore extends DurableObject<Env> {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  async storePreview(
    input: Omit<SAMLAggregatePreviewState, 'createdAt' | 'expiresAt'> & {
      expiresAt?: number;
    }
  ): Promise<SAMLAggregatePreviewState> {
    const now = Date.now();
    const preview: SAMLAggregatePreviewState = {
      ...input,
      createdAt: now,
      expiresAt: input.expiresAt ?? now + PREVIEW_TTL_MS,
    };

    await this.deletePreview(input.previewId);
    const metadataXmlChunks = await this.putChunks(
      `preview:${input.previewId}:xml`,
      preview.metadataXml
    );
    const entitiesChunks = await this.putChunks(
      `preview:${input.previewId}:entities`,
      JSON.stringify(preview.entities)
    );

    await this.state.storage.put<StoredPreviewManifest>(`preview:${input.previewId}:manifest`, {
      previewId: input.previewId,
      tenantId: input.tenantId,
      metadataUrl: input.metadataUrl,
      verification: input.verification,
      createdAt: preview.createdAt,
      expiresAt: preview.expiresAt,
      metadataXmlChunks,
      entitiesChunks,
    });

    return preview;
  }

  async getPreview(previewId: string): Promise<SAMLAggregatePreviewState | null> {
    const manifest = await this.state.storage.get<StoredPreviewManifest>(
      `preview:${previewId}:manifest`
    );
    if (!manifest) {
      return null;
    }
    if (Date.now() > manifest.expiresAt) {
      await this.deletePreview(previewId);
      return null;
    }

    const [metadataXml, entitiesJson] = await Promise.all([
      this.getChunks(`preview:${previewId}:xml`, manifest.metadataXmlChunks),
      this.getChunks(`preview:${previewId}:entities`, manifest.entitiesChunks),
    ]);

    return {
      previewId,
      tenantId: manifest.tenantId,
      metadataUrl: manifest.metadataUrl,
      metadataXml,
      entities: JSON.parse(entitiesJson) as SAMLMetadataEntitySummary[],
      verification: manifest.verification,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
    };
  }

  async listEntities(
    previewId: string,
    input: { query?: string; keywords?: string[]; offset?: number; limit?: number }
  ): Promise<{
    total: number;
    offset: number;
    limit: number;
    entities: SAMLMetadataEntitySummary[];
    keywordFacets: SAMLMetadataKeywordFacet[];
  }> {
    const preview = await this.getPreview(previewId);
    if (!preview) {
      throw new Error('preview_not_found');
    }

    const normalizedQuery = input.query?.trim().toLowerCase();
    const textFiltered = normalizedQuery
      ? preview.entities.filter((entity) =>
          [
            entity.entityId,
            entity.role,
            entity.displayName,
            entity.acsUrl,
            entity.ssoUrl,
            entity.sloUrl,
            ...(entity.keywords ?? []),
          ]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(normalizedQuery))
        )
      : preview.entities;
    const keywordFilters = Array.from(new Set(input.keywords ?? [])).filter(Boolean);
    const filtered =
      keywordFilters.length > 0
        ? textFiltered.filter((entity) =>
            keywordFilters.some((keyword) => entity.keywords?.includes(keyword))
          )
        : textFiltered;

    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(Math.max(1, input.limit ?? 50), 200);

    return {
      total: filtered.length,
      offset,
      limit,
      entities: filtered.slice(offset, offset + limit),
      keywordFacets: buildKeywordFacets(textFiltered),
    };
  }

  async startBatch(
    batchId: string,
    total: number,
    tenantId: string
  ): Promise<SAMLMetadataBatchStatusResponse> {
    const now = Date.now();
    const status: SAMLMetadataBatchStatusResponse = {
      batchId,
      tenantId,
      status: 'running',
      total,
      processed: 0,
      succeeded: 0,
      failed: 0,
      startedAt: now,
      results: [],
    };
    await this.state.storage.put(`batch:${batchId}`, status);
    return status;
  }

  async recordBatchResult(batchId: string, result: SAMLMetadataBatchCreateResult): Promise<void> {
    const status = await this.getBatch(batchId);
    if (!status) {
      throw new Error('batch_not_found');
    }
    if (status.status === 'completed' || status.status === 'failed') {
      return;
    }

    status.results.push(result);
    status.processed = status.results.length;
    status.succeeded = status.results.filter((item) => item.success).length;
    status.failed = status.results.filter((item) => !item.success).length;
    await this.state.storage.put(`batch:${batchId}`, status);
  }

  async completeBatch(batchId: string): Promise<void> {
    const status = await this.getBatch(batchId);
    if (!status) {
      return;
    }
    status.status = 'completed';
    status.completedAt = Date.now();
    await this.state.storage.put(`batch:${batchId}`, status);
  }

  async failBatch(batchId: string, error: string): Promise<void> {
    const status = await this.getBatch(batchId);
    if (!status) {
      return;
    }
    status.status = 'failed';
    status.error = error;
    status.completedAt = Date.now();
    await this.state.storage.put(`batch:${batchId}`, status);
  }

  async getBatch(batchId: string): Promise<SAMLMetadataBatchStatusResponse | null> {
    return (
      (await this.state.storage.get<SAMLMetadataBatchStatusResponse>(`batch:${batchId}`)) ?? null
    );
  }

  private async deletePreview(previewId: string): Promise<void> {
    const manifest = await this.state.storage.get<StoredPreviewManifest>(
      `preview:${previewId}:manifest`
    );
    if (!manifest) {
      return;
    }
    const keys = [`preview:${previewId}:manifest`];
    for (let i = 0; i < manifest.metadataXmlChunks; i++) {
      keys.push(`preview:${previewId}:xml:${i}`);
    }
    for (let i = 0; i < manifest.entitiesChunks; i++) {
      keys.push(`preview:${previewId}:entities:${i}`);
    }
    await this.state.storage.delete(keys);
  }

  private async putChunks(prefix: string, value: string): Promise<number> {
    const chunks: Record<string, string> = {};
    const count = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
    for (let i = 0; i < count; i++) {
      chunks[`${prefix}:${i}`] = value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }
    await this.state.storage.put(chunks);
    return count;
  }

  private async getChunks(prefix: string, count: number): Promise<string> {
    const keys = Array.from({ length: count }, (_, index) => `${prefix}:${index}`);
    const chunks = await this.state.storage.get<string>(keys);
    return keys.map((key) => chunks.get(key) ?? '').join('');
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/preview' && request.method === 'POST') {
        const body = (await request.json()) as Parameters<typeof this.storePreview>[0];
        const preview = await this.storePreview(body);
        return json(preview);
      }

      if (path.startsWith('/preview/') && path.endsWith('/entities') && request.method === 'GET') {
        const previewId = path.slice('/preview/'.length, -'/entities'.length);
        return json(
          await this.listEntities(previewId, {
            query: url.searchParams.get('query') ?? undefined,
            keywords: url.searchParams.getAll('keyword').filter(Boolean),
            offset: parseInteger(url.searchParams.get('offset')),
            limit: parseInteger(url.searchParams.get('limit')),
          })
        );
      }

      if (path.startsWith('/preview/') && request.method === 'GET') {
        const previewId = path.substring('/preview/'.length);
        const preview = await this.getPreview(previewId);
        return preview ? json(preview) : json({ error: 'preview_not_found' }, 404);
      }

      if (path === '/batch' && request.method === 'POST') {
        const body = (await request.json()) as {
          batchId: string;
          tenantId?: string;
          total: number;
        };
        if (!body.tenantId) {
          return json({ error: 'tenant_id_required' }, 400);
        }
        return json(await this.startBatch(body.batchId, body.total, body.tenantId));
      }

      if (path.startsWith('/batch/') && path.endsWith('/result') && request.method === 'POST') {
        const batchId = path.slice('/batch/'.length, -'/result'.length);
        await this.recordBatchResult(
          batchId,
          (await request.json()) as SAMLMetadataBatchCreateResult
        );
        return json({ success: true });
      }

      if (path.startsWith('/batch/') && path.endsWith('/complete') && request.method === 'POST') {
        const batchId = path.slice('/batch/'.length, -'/complete'.length);
        await this.completeBatch(batchId);
        return json({ success: true });
      }

      if (path.startsWith('/batch/') && path.endsWith('/fail') && request.method === 'POST') {
        const batchId = path.slice('/batch/'.length, -'/fail'.length);
        const body = (await request.json()) as { error?: string };
        await this.failBatch(batchId, body.error ?? 'Batch failed');
        return json({ success: true });
      }

      if (path.startsWith('/batch/') && request.method === 'GET') {
        const batchId = path.substring('/batch/'.length);
        const status = await this.getBatch(batchId);
        return status ? json(status) : json({ error: 'batch_not_found' }, 404);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'internal_error' }, 500);
    }
  }
}

function parseInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseKeyword(keyword: string): { category: string; value: string } {
  const parts = keyword
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'category') {
    return { category: parts[1], value: parts.slice(2).join(':') };
  }
  if (parts.length >= 2) {
    return { category: parts[0], value: parts.slice(1).join(':') };
  }
  return { category: 'keyword', value: keyword };
}

function buildKeywordFacets(entities: SAMLMetadataEntitySummary[]): SAMLMetadataKeywordFacet[] {
  const categories = new Map<string, Map<string, { label: string; count: number }>>();
  for (const entity of entities) {
    for (const keyword of new Set(entity.keywords ?? [])) {
      const parsed = parseKeyword(keyword);
      const values =
        categories.get(parsed.category) ?? new Map<string, { label: string; count: number }>();
      const current = values.get(keyword) ?? { label: parsed.value, count: 0 };
      current.count += 1;
      values.set(keyword, current);
      categories.set(parsed.category, values);
    }
  }

  return Array.from(categories.entries())
    .map(([category, values]) => ({
      category,
      label: category,
      values: Array.from(values.entries())
        .map(([keyword, value]) => ({ keyword, label: value.label, count: value.count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
