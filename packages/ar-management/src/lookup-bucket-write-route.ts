import type {
  D1Database,
  D1DatabaseSession,
  D1PreparedStatement,
  D1Result,
  D1SessionBookmark,
  D1SessionConstraint,
} from '@cloudflare/workers-types';
import {
  loadVerifiedLookupBucketAssignmentProvider,
  type ControlLookupBucketRouteTarget,
  type ControlLookupBucketWriteRoute,
  type Env,
} from '@authrim/ar-lib-core';

const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

function binding(env: Env, bindingRef: string): D1Database {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') throw new Error('lookup_write_binding_unavailable');
  const candidate = value as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('lookup_write_binding_unavailable');
  }
  return value as D1Database;
}

function strictTarget(value: ControlLookupBucketRouteTarget): ControlLookupBucketRouteTarget {
  if (
    !value ||
    !SAFE_ID.test(value.lookupShardId) ||
    !SAFE_BINDING.test(value.bindingRef) ||
    !Number.isSafeInteger(value.assignmentGeneration) ||
    value.assignmentGeneration < 1
  ) {
    throw new Error('lookup_write_route_invalid');
  }
  return value;
}

function strictRoute(value: ControlLookupBucketWriteRoute, virtualBucket: number) {
  if (
    !value ||
    value.virtualBucket !== virtualBucket ||
    !Array.isArray(value.mirrors) ||
    value.mirrors.length > 1
  ) {
    throw new Error('lookup_write_route_invalid');
  }
  const targets = [strictTarget(value.primary), ...value.mirrors.map(strictTarget)];
  if (
    new Set(targets.map((target) => target.lookupShardId)).size !== targets.length ||
    new Set(targets.map((target) => target.bindingRef)).size !== targets.length ||
    new Set(targets.map((target) => target.assignmentGeneration)).size !== targets.length
  ) {
    throw new Error('lookup_write_route_invalid');
  }
  if (value.migration === null && targets.length !== 1) {
    throw new Error('lookup_write_route_invalid');
  }
  if (
    value.migration !== null &&
    (!SAFE_ID.test(value.migration.operationId) || value.migration.state === 'complete')
  ) {
    throw new Error('lookup_write_route_invalid');
  }
  return targets;
}

function equalResult(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class MirroredPreparedStatement {
  constructor(private readonly statements: D1PreparedStatement[]) {}

  bind(...values: unknown[]): MirroredPreparedStatement {
    return new MirroredPreparedStatement(
      this.statements.map((statement) => statement.bind(...values))
    );
  }

  async first<T>(column?: string): Promise<T | null> {
    const results = await Promise.all(
      this.statements.map((statement) =>
        column === undefined ? statement.first<T>() : statement.first<T>(column)
      )
    );
    if (results.some((result) => !equalResult(result, results[0]))) {
      throw new Error('lookup_write_reflection_mismatch');
    }
    return results[0];
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = await Promise.all(this.statements.map((statement) => statement.all<T>()));
    if (results.some((result) => !equalResult(result.results, results[0].results))) {
      throw new Error('lookup_write_reflection_mismatch');
    }
    return results[0];
  }

  async run<T>(): Promise<D1Result<T>> {
    const results = await Promise.all(this.statements.map((statement) => statement.run<T>()));
    return results[0];
  }

  async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
    const results = await Promise.all(
      this.statements.map((statement) =>
        (statement.raw as unknown as (input?: { columnNames?: boolean }) => Promise<unknown[]>)(
          options
        )
      )
    );
    if (results.some((result) => !equalResult(result, results[0]))) {
      throw new Error('lookup_write_reflection_mismatch');
    }
    return results[0] as T[];
  }

  statement(index: number): D1PreparedStatement {
    const statement = this.statements[index];
    if (!statement) throw new Error('lookup_write_statement_invalid');
    return statement;
  }
}

function mirroredSession(sessions: D1DatabaseSession[]): D1DatabaseSession {
  const session = {
    prepare(sql: string) {
      return new MirroredPreparedStatement(sessions.map((candidate) => candidate.prepare(sql)));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const mirrored = statements.map((statement) => {
        if (!(statement instanceof MirroredPreparedStatement)) {
          throw new Error('lookup_write_statement_invalid');
        }
        return statement;
      });
      const results = await Promise.all(
        sessions.map((candidate, index) =>
          candidate.batch<T>(mirrored.map((statement) => statement.statement(index)))
        )
      );
      return results[0];
    },
    getBookmark(): D1SessionBookmark | null {
      return sessions[0].getBookmark();
    },
  };
  return session as unknown as D1DatabaseSession;
}

function mirroredDatabase(databases: D1Database[]): D1Database {
  if (databases.length === 1) return databases[0];
  const database = {
    prepare(sql: string) {
      return new MirroredPreparedStatement(databases.map((candidate) => candidate.prepare(sql)));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const mirrored = statements.map((statement) => {
        if (!(statement instanceof MirroredPreparedStatement)) {
          throw new Error('lookup_write_statement_invalid');
        }
        return statement;
      });
      const results = await Promise.all(
        databases.map((candidate, index) =>
          candidate.batch<T>(mirrored.map((statement) => statement.statement(index)))
        )
      );
      return results[0];
    },
    withSession(constraintOrBookmark?: D1SessionConstraint | D1SessionBookmark) {
      return mirroredSession(
        databases.map((candidate) => candidate.withSession(constraintOrBookmark))
      );
    },
  };
  return database as unknown as D1Database;
}

export async function createLookupBucketWriteResolver(
  env: Env
): Promise<(virtualBucket: number) => Promise<D1Database>> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !SAFE_ID.test(environmentId) ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('lookup_write_route_unavailable');
  }
  const assignments = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  });
  return async (virtualBucket) => {
    const active = await assignments.resolveActiveAssignment(virtualBucket);
    const route =
      env.CONTROL && typeof env.CONTROL.getLookupBucketWriteRoute === 'function'
        ? await env.CONTROL.getLookupBucketWriteRoute({ virtualBucket })
        : {
            virtualBucket,
            primary: {
              lookupShardId: active.lookupShardId,
              bindingRef: active.bindingRef,
              assignmentGeneration: active.assignmentGeneration,
            },
            mirrors: [],
            migration: null,
          };
    const targets = strictRoute(route, virtualBucket);
    const activeIndex = targets.findIndex(
      (target) =>
        target.lookupShardId === active.lookupShardId &&
        target.bindingRef === active.bindingRef &&
        target.assignmentGeneration === active.assignmentGeneration
    );
    if (activeIndex < 0) throw new Error('lookup_write_registry_route_mismatch');
    const ordered = [
      targets[activeIndex],
      ...targets.filter((_target, index) => index !== activeIndex),
    ];
    return mirroredDatabase(ordered.map((target) => binding(env, target.bindingRef)));
  };
}
