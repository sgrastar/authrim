import type { MiddlewareHandler } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALWAYS_ALLOWED_PATHS = new Set(['/api/admin/logout']);
const SAFE_RECOVERY_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:%-]{0,511}$/u;

function isAuthorizedReleaseRecoveryPath(path: string): boolean {
  const segments = path.split('/');
  return (
    segments.length === 10 &&
    segments[1] === 'api' &&
    segments[2] === 'admin' &&
    segments[3] === 'platform' &&
    segments[4] === 'control-plane' &&
    segments[5] === 'release-rollout' &&
    SAFE_RECOVERY_SEGMENT.test(segments[6] ?? '') &&
    segments[7] === 'targets' &&
    SAFE_RECOVERY_SEGMENT.test(segments[8] ?? '') &&
    segments[9] === 'retry'
  );
}

export function releaseRolloutMutationFenceMiddleware(): MiddlewareHandler<{
  Bindings: Env;
}> {
  return async (c, next) => {
    if (
      SAFE_METHODS.has(c.req.method) ||
      ALWAYS_ALLOWED_PATHS.has(c.req.path) ||
      (c.req.method === 'POST' && isAuthorizedReleaseRecoveryPath(c.req.path))
    ) {
      return next();
    }
    const control = c.env.CONTROL;
    if (!control?.getReleaseMigrationRolloutStatus) {
      c.header('Cache-Control', 'no-store');
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
          message: 'Release rollout state could not be verified. Administrative writes are paused.',
        },
        503
      );
    }

    let status;
    try {
      status = await control.getReleaseMigrationRolloutStatus();
    } catch {
      c.header('Cache-Control', 'no-store');
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE',
          message: 'Release rollout state could not be verified. Administrative writes are paused.',
        },
        503
      );
    }
    if (status.adminMutationMode !== 'read_only') return next();

    c.header('Cache-Control', 'no-store');
    c.header('Retry-After', '5');
    return c.json(
      {
        error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE',
        message:
          'This operation is temporarily unavailable while the release update is in progress.',
        operationId: status.operationId,
        targetVersion: status.targetVersion,
        phase: status.phase,
      },
      409
    );
  };
}
