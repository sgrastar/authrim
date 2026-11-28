/**
 * ReBAC Service Implementation
 *
 * Main service for Relationship-Based Access Control.
 * Implements Zanzibar-lite check() API with:
 * - Direct tuples, contextual tuples and group usersets (userset.ts)
 * - Relation DSL evaluation (union, tuple-to-userset, intersection, exclusion), three-valued
 * - KV caching with configurable TTL, keyed by a per-tenant ReBAC version
 * - Request-scoped deduplication
 *
 * A relation with an active definition is decided by the definition alone (tuples count only
 * through its `direct` leaves, and `tuple_to_userset` evaluates the computed relation on the
 * related object through that object's own definition). A relation without one holds through
 * direct tuples and group usersets only: no other traversal of the relationship graph grants
 * anything. An unusable stored definition, a cycle or the depth limit leaves a check undecided
 * (denied, never cached).
 *
 * Lists (listObjects / listUsers) take their candidates from direct subject tuples and keep only
 * those the check allows: group usersets (`userset_subjects_omitted`) and computed relations
 * (`computed_relations_omitted`) are not enumerated.
 */

import type {
  ActiveDefinition,
  IReBACService,
  IReBACCacheManager,
  IClosureManager,
  IRelationParser,
  MembershipTrace,
  EvaluationResult,
} from './interfaces';
import type {
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  ReBACConfig,
  ReBACCheckOptions,
  RelationExpression,
  ResolvedCheckRequest,
  SubjectGroupsResolver,
} from './types';
import type { IStorageAdapter } from '../storage/interfaces';
import { ReBACCacheManager, getReBACTenantVersion } from './cache-manager';
import { RelationParser, createEvaluationContext, parseObjectString } from './relation-parser';
import { DEFAULT_CACHE_TTL, DEFAULT_MAX_DEPTH } from './types';
import {
  createMembershipTrace,
  expressionContainsTupleToUserset,
  memoizeServiceDecidedGroups,
  MAX_DEFINITION_DEPTH,
  memoizeSubjectGroups,
  USERSET_GROUP_FROM_TYPE,
  USERSET_MEMBER_RELATION,
} from './userset';
import { memoizeDefinitions } from './definitions';

/**
 * A subject id as `/api/rebac/*` callers write it: `user:<id>` or `<id>`. Only a single leading
 * `user:` is taken away; the rest is the stored id verbatim (`team:alice` stays `team:alice`,
 * `user:team:alice` is `team:alice`), so an id a list returns checks the same subject.
 */
export function externalSubjectId(userId: string): string {
  return userId.startsWith('user:') ? userId.slice('user:'.length) : userId;
}

/**
 * A stored subject id as `/api/rebac/*` returns it: `user:` + the stored id, so that the single
 * prefix externalSubjectId takes away gives the stored id back (`alice` → `user:alice`,
 * `user:alice` → `user:user:alice`).
 */
export function externalSubjectRef(storedId: string): string {
  return `user:${storedId}`;
}

/**
 * The relations a definition's `direct` leaves name (outside tuple_to_userset): their direct
 * tuples are list candidates as well (`viewer = direct(editor)` lists editors).
 */
function directLeafRelations(expression: RelationExpression, depth = 0): Set<string> {
  const relations = new Set<string>();
  if (depth > MAX_DEFINITION_DEPTH) return relations;
  switch (expression.type) {
    case 'direct':
      relations.add(expression.relation);
      break;
    case 'union':
    case 'intersection':
      for (const child of expression.children)
        for (const relation of directLeafRelations(child, depth + 1)) relations.add(relation);
      break;
    case 'exclusion':
      // A subtract only takes away: its relations are no candidates.
      for (const relation of directLeafRelations(expression.base, depth + 1))
        relations.add(relation);
      break;
    default:
      break;
  }
  return relations;
}

/**
 * ReBACService - Main ReBAC service implementation
 */
export class ReBACService implements IReBACService {
  private adapter: IStorageAdapter;
  private cacheManager: IReBACCacheManager;
  private relationParser: IRelationParser;
  private closureManager: IClosureManager | null;
  private config: Required<Omit<ReBACConfig, 'subject_groups' | 'version_namespace'>>;
  private subjectGroups?: SubjectGroupsResolver;
  private versionNamespace?: KVNamespace;

  constructor(
    adapter: IStorageAdapter,
    config?: ReBACConfig,
    cacheManager?: IReBACCacheManager,
    closureManager?: IClosureManager | null,
    relationParser?: IRelationParser
  ) {
    this.adapter = adapter;
    this.config = {
      cache_namespace: config?.cache_namespace ?? (null as unknown as KVNamespace),
      cache_ttl: config?.cache_ttl ?? DEFAULT_CACHE_TTL,
      max_depth: config?.max_depth ?? DEFAULT_MAX_DEPTH,
      enable_closure_table: config?.enable_closure_table ?? true,
      closure_batch_size: config?.closure_batch_size ?? 100,
    };
    this.subjectGroups = config?.subject_groups;
    this.versionNamespace = config?.version_namespace;

    this.cacheManager =
      cacheManager ??
      new ReBACCacheManager(this.config.cache_namespace ?? undefined, this.config.cache_ttl);
    this.relationParser = relationParser ?? new RelationParser();
    this.closureManager = closureManager ?? null;
  }

  /**
   * Check if a user has a specific relation to an object (the `/api/rebac/*` boundary: the user
   * and the object may be typed strings, parsed here).
   */
  async check(request: CheckRequest, options?: ReBACCheckOptions): Promise<CheckResponse> {
    const { type: objectType, id: objectId } = request.object_type
      ? { type: request.object_type, id: request.object }
      : parseObjectString(request.object);
    const subjectId = externalSubjectId(request.user_id);
    const contextualTuples = (request.context?.contextual_tuples ?? [])
      .filter((tuple) => externalSubjectId(tuple.user_id) === subjectId)
      .map((tuple) => {
        const object = tuple.object_type
          ? { type: tuple.object_type, id: tuple.object }
          : parseObjectString(tuple.object);
        return { relation: tuple.relation, objectType: object.type, objectId: object.id };
      });
    return this.checkResolved(
      {
        tenantId: request.tenant_id,
        subjectId,
        relation: request.relation,
        objectType,
        objectId,
        ...(request.context?.contextual_tuples?.length ? { contextualTuples } : {}),
      },
      options
    );
  }

  /**
   * A check of an already resolved subject (taken verbatim: it may contain `:`) and a typed
   * object. Request-specific (contextual) tuples are seen by every `direct` lookup under the same
   * definitions; such a check neither reads nor writes the shared cache.
   */
  async checkResolved(
    request: ResolvedCheckRequest,
    options?: ReBACCheckOptions
  ): Promise<CheckResponse> {
    const contextual = request.contextualTuples !== undefined;
    const scope = contextual ? null : await this.cacheScope(request.tenantId);

    if (scope !== null) {
      // A cache that cannot be read is a miss: the check is evaluated from the database.
      let cached: CheckResponse | null = null;
      try {
        cached = await this.cacheManager.get(
          scope,
          request.subjectId,
          request.relation,
          request.objectType,
          request.objectId
        );
      } catch {
        cached = null;
      }
      if (cached) return cached;
    }

    const { result, cacheable, ttl } = await this.computeCheck(
      request,
      options?.subjectGroups ?? this.subjectGroups
    );

    if (scope !== null && cacheable) {
      // A cache that cannot be written does not change the answer.
      try {
        await this.cacheManager.set(
          scope,
          request.subjectId,
          request.relation,
          request.objectType,
          request.objectId,
          result,
          ttl
        );
      } catch {
        // Not cached.
      }
    }
    return result;
  }

  /**
   * The tenant part of the cache key, with the tenant's ReBAC version (bumped by every tuple and
   * definition write), or null when results must not be cached: the version cannot be read, or
   * a shared cache is configured without a version store.
   */
  private async cacheScope(tenantId: string): Promise<string | null> {
    if (!this.versionNamespace) {
      // A per-instance cache (no KV) lives one request; a shared one needs the version.
      return this.config.cache_namespace ? null : JSON.stringify([tenantId, '0']);
    }
    try {
      return JSON.stringify([
        tenantId,
        await getReBACTenantVersion(this.versionNamespace, tenantId),
      ]);
    } catch {
      return null;
    }
  }

  /**
   * Batch check multiple authorization requests
   */
  async batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse> {
    // Identical checks of the batch share one evaluation (in flight or done), so duplicates
    // neither repeat the work nor race on the cache. Checks with contextual tuples are not
    // shared: they differ by their tuples.
    const inFlight = new Map<string, Promise<CheckResponse>>();

    const results = await Promise.all(
      request.checks.map((checkRequest) => {
        if (checkRequest.context?.contextual_tuples?.length) return this.check(checkRequest);
        const { type: objectType, id: objectId } = checkRequest.object_type
          ? { type: checkRequest.object_type, id: checkRequest.object }
          : parseObjectString(checkRequest.object);
        const key = JSON.stringify([
          checkRequest.tenant_id,
          externalSubjectId(checkRequest.user_id),
          checkRequest.relation,
          objectType,
          objectId,
        ]);
        let result = inFlight.get(key);
        if (!result) {
          result = this.check(checkRequest);
          inFlight.set(key, result);
        }
        return result;
      })
    );

    return { results };
  }

  /**
   * List all objects a user has a specific relation to
   */
  async listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse> {
    const userId = externalSubjectId(request.user_id);

    const definitions = new Map<string, Promise<ActiveDefinition>>();
    const relations = await this.candidateRelations(
      request.tenant_id,
      request.object_type,
      request.relation,
      definitions
    );

    // Candidates: the subject's live direct tuples of those relations (the closure holds no more
    // than those, and is used for the requested relation alone)
    let page: { ids: string[]; nextCursor?: string };
    if (this.closureManager && relations.length === 1 && relations[0] === request.relation) {
      const result = await this.closureManager.getObjectsForUser(
        request.tenant_id,
        userId,
        request.relation,
        request.object_type,
        { limit: request.limit, cursor: request.cursor }
      );
      page = { ids: result.objectIds, nextCursor: result.nextCursor };
    } else {
      page = await this.listDirectObjects(request, userId, relations);
    }

    const objectIds = await this.keepAllowed(page.ids, (objectId) =>
      this.computeCheck(
        {
          tenantId: request.tenant_id,
          subjectId: userId,
          relation: request.relation,
          objectType: request.object_type,
          objectId,
        },
        this.subjectGroups,
        definitions
      )
    );

    return {
      object_ids: objectIds,
      next_cursor: page.nextCursor,
      userset_subjects_omitted: await this.hasGroupUsersets(
        request.tenant_id,
        request.object_type,
        relations
      ),
      computed_relations_omitted: await this.hasComputedRelations(
        request.tenant_id,
        request.object_type
      ),
    };
  }

  /**
   * List all users who have a specific relation to an object
   */
  async listUsers(request: ListUsersRequest): Promise<ListUsersResponse> {
    const { type: objectType, id: objectId } = request.object_type
      ? { type: request.object_type, id: request.object }
      : parseObjectString(request.object);

    const definitions = new Map<string, Promise<ActiveDefinition>>();
    const relations = await this.candidateRelations(
      request.tenant_id,
      objectType,
      request.relation,
      definitions
    );

    // Candidates: the live direct subject tuples on the object of those relations (the closure
    // holds no more than those, and is used for the requested relation alone)
    let page: { ids: string[]; nextCursor?: string };
    if (this.closureManager && relations.length === 1 && relations[0] === request.relation) {
      const result = await this.closureManager.getUsersForObject(
        request.tenant_id,
        objectType,
        objectId,
        request.relation,
        { limit: request.limit, cursor: request.cursor }
      );
      page = { ids: result.userIds, nextCursor: result.nextCursor };
    } else {
      page = await this.listDirectUsers(
        request.tenant_id,
        objectType,
        objectId,
        relations,
        request.limit,
        request.cursor
      );
    }

    const userIds = await this.keepAllowed(page.ids, (userId) =>
      this.computeCheck(
        {
          tenantId: request.tenant_id,
          subjectId: userId,
          relation: request.relation,
          objectType,
          objectId,
        },
        this.subjectGroups,
        definitions
      )
    );

    return {
      user_ids: userIds,
      next_cursor: page.nextCursor,
      userset_subjects_omitted: await this.hasGroupUsersets(
        request.tenant_id,
        objectType,
        relations,
        objectId
      ),
      computed_relations_omitted: await this.hasComputedRelations(request.tenant_id, objectType),
    };
  }

  /**
   * Invalidate cache for a specific object (under the tenant's current ReBAC version; a write
   * also bumps the version, which retires every entry of the tenant)
   */
  async invalidateCache(
    tenantId: string,
    objectType: string,
    objectId: string,
    _relation?: string
  ): Promise<void> {
    const scope = await this.cacheScope(tenantId);
    if (scope !== null) await this.cacheManager.invalidateObject(scope, objectType, objectId);

    // Also update closure table if enabled
    if (this.closureManager) {
      await this.closureManager.recomputeForObject(tenantId, objectType, objectId);
    }
  }

  /**
   * Invalidate all cache entries for a user
   */
  async invalidateUserCache(tenantId: string, userId: string): Promise<void> {
    const scope = await this.cacheScope(tenantId);
    if (scope !== null) await this.cacheManager.invalidateUser(scope, userId);

    // Also update closure table if enabled
    if (this.closureManager) {
      await this.closureManager.recomputeForUser(tenantId, userId);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Compute a check: the relation on the object, as RelationParser.evaluateRelation evaluates it
   * (its definition, or direct tuples and group usersets without one). An undecided answer is a
   * deny that is never cached (`unknown_membership` when a group userset left it undecided).
   * A result is cacheable only when it read no memberships, depends on no request-specific tuple,
   * and no tuple it relied on expires within the cache TTL.
   */
  private async computeCheck(
    request: ResolvedCheckRequest,
    subjectGroups: SubjectGroupsResolver | undefined,
    definitionMemo?: Map<string, Promise<ActiveDefinition>>
  ): Promise<{ result: CheckResponse; cacheable: boolean; ttl: number }> {
    const trace: MembershipTrace = createMembershipTrace();
    const definitions = memoizeDefinitions(
      this.adapter,
      this.relationParser,
      request.tenantId,
      definitionMemo
    );
    const context = createEvaluationContext(
      request.tenantId,
      request.subjectId,
      request.objectType,
      request.objectId,
      this.config.max_depth,
      {
        subject_groups: memoizeSubjectGroups(subjectGroups, request.tenantId, request.subjectId),
        membership: trace,
        definitions,
        service_decided_groups: memoizeServiceDecidedGroups(this.adapter, request.tenantId),
        ...(request.contextualTuples && {
          contextual: request.contextualTuples.map((tuple) => ({
            relation: tuple.relation,
            object_type: tuple.objectType,
            object_id: tuple.objectId,
          })),
        }),
      }
    );
    const definition = await definitions(request.objectType, request.relation);
    const outcome: EvaluationResult = await this.relationParser.evaluateRelation(
      request.objectType,
      request.objectId,
      request.relation,
      context,
      this.adapter
    );

    const ttl = this.config.cache_ttl;
    const now = Math.floor(Date.now() / 1000);
    const cacheable =
      outcome !== 'unknown' &&
      !trace.consulted &&
      !trace.indeterminate &&
      request.contextualTuples === undefined &&
      (trace.minExpiresAt === null || trace.minExpiresAt > now + ttl);
    const computed = definition.state !== 'none';

    if (outcome === 'allow') {
      const viaContext =
        trace.grants.length > 0 &&
        trace.grants.every((grant) => grant.endsWith('@contextual_tuple'));
      return {
        result: {
          allowed: true,
          resolved_via: viaContext ? 'context' : computed ? 'computed' : 'direct',
          path: trace.grants.map((grant) => grant.slice(grant.lastIndexOf('@') + 1)),
        },
        cacheable,
        ttl,
      };
    }
    return {
      result: {
        allowed: false,
        resolved_via:
          outcome === 'unknown' && trace.unknown
            ? 'unknown_membership'
            : computed
              ? 'computed'
              : 'direct',
      },
      cacheable,
      ttl,
    };
  }

  /**
   * The relations whose direct tuples are list candidates: the requested one without a
   * definition; with one, the relations its `direct` leaves name (none under an unusable one).
   */
  private async candidateRelations(
    tenantId: string,
    objectType: string,
    relation: string,
    memo: Map<string, Promise<ActiveDefinition>>
  ): Promise<string[]> {
    const definition = await memoizeDefinitions(
      this.adapter,
      this.relationParser,
      tenantId,
      memo
    )(objectType, relation);
    if (definition.state === 'none') return [relation];
    if (definition.state === 'unusable') return [];
    return [...directLeafRelations(definition.definition.definition)].sort();
  }

  /** The list candidates the check allows (each checked: a list never returns a deny). */
  private async keepAllowed(
    candidates: string[],
    check: (candidate: string) => Promise<{ result: CheckResponse }>
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const candidate of candidates) {
      if ((await check(candidate)).result.allowed) kept.push(candidate);
    }
    return kept;
  }

  /**
   * Whether the tenant has an unexpired group userset tuple (`from_relation = 'member'`) for one
   * of the relations the list takes candidates from (candidateRelations) on the object type (on
   * the one object, when given).
   */
  private async hasGroupUsersets(
    tenantId: string,
    objectType: string,
    relations: string[],
    objectId?: string
  ): Promise<boolean> {
    if (relations.length === 0) return false;
    const rows = await this.adapter.query<{ id: string }>(
      `SELECT id FROM relationships
       WHERE tenant_id = ?
         AND from_type = '${USERSET_GROUP_FROM_TYPE}'
         AND from_relation = '${USERSET_MEMBER_RELATION}'
         AND to_type = ?
         ${objectId === undefined ? '' : 'AND to_id = ?'}
         AND relationship_type IN (${relations.map(() => '?').join(', ')})
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
      [
        tenantId,
        objectType,
        ...(objectId === undefined ? [] : [objectId]),
        ...relations,
        Math.floor(Date.now() / 1000),
      ]
    );
    return rows.length > 0;
  }

  /**
   * Whether an active definition of the object type contains a `tuple_to_userset` (relations
   * the lists do not enumerate). A definition that cannot be parsed counts as one.
   */
  private async hasComputedRelations(tenantId: string, objectType: string): Promise<boolean> {
    const rows = await this.adapter.query<{ definition_json: string }>(
      `SELECT definition_json FROM relation_definitions
        WHERE tenant_id = ? AND object_type = ? AND is_active = 1`,
      [tenantId, objectType]
    );
    return rows.some((row) => {
      try {
        return expressionContainsTupleToUserset(this.relationParser.parse(row.definition_json));
      } catch {
        return true;
      }
    });
  }

  /**
   * The objects of a type the subject has a live, unexpired direct tuple to with the relation
   * (when no closure manager is configured).
   */
  private async listDirectObjects(
    request: ListObjectsRequest,
    userId: string,
    relations: string[]
  ): Promise<{ ids: string[]; nextCursor?: string }> {
    if (relations.length === 0) return { ids: [] };
    const now = Math.floor(Date.now() / 1000);
    const limit = request.limit ?? 100;
    const offset = request.cursor ? parseInt(request.cursor, 10) : 0;

    const results = await this.adapter.query<{ object_id: string }>(
      `SELECT DISTINCT to_id AS object_id
       FROM relationships
       WHERE tenant_id = ?
         AND from_type = 'subject'
         AND from_id = ?
         AND to_type = ?
         AND relationship_type IN (${relations.map(() => '?').join(', ')})
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY to_id
       LIMIT ? OFFSET ?`,
      [request.tenant_id, userId, request.object_type, ...relations, now, limit + 1, offset]
    );

    const hasMore = results.length > limit;
    return {
      ids: results.slice(0, limit).map((r) => r.object_id),
      nextCursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  /**
   * The subjects with a live, unexpired direct tuple to the object with the relation (when no
   * closure manager is configured).
   */
  private async listDirectUsers(
    tenantId: string,
    objectType: string,
    objectId: string,
    relations: string[],
    limit?: number,
    cursor?: string
  ): Promise<{ ids: string[]; nextCursor?: string }> {
    if (relations.length === 0) return { ids: [] };
    const now = Math.floor(Date.now() / 1000);
    const queryLimit = limit ?? 100;
    const offset = cursor ? parseInt(cursor, 10) : 0;

    const results = await this.adapter.query<{ user_id: string }>(
      `SELECT DISTINCT from_id AS user_id
       FROM relationships
       WHERE tenant_id = ?
         AND from_type = 'subject'
         AND to_type = ?
         AND to_id = ?
         AND relationship_type IN (${relations.map(() => '?').join(', ')})
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY from_id
       LIMIT ? OFFSET ?`,
      [tenantId, objectType, objectId, ...relations, now, queryLimit + 1, offset]
    );

    const hasMore = results.length > queryLimit;
    return {
      ids: results.slice(0, queryLimit).map((r) => r.user_id),
      nextCursor: hasMore ? String(offset + queryLimit) : undefined,
    };
  }
}

/**
 * Create a ReBACService instance
 */
export function createReBACService(adapter: IStorageAdapter, config?: ReBACConfig): ReBACService {
  return new ReBACService(adapter, config);
}
