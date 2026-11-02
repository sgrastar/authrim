// Disposable benchmark only. Bind DB to the synthetic source and CONTROL to a separate empty D1.
// BENCH_TOKEN must be installed as a Worker secret, never a Wrangler vars entry.

const encoder = new TextEncoder();
const MAX_TOKEN_LENGTH = 1024;

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

async function authorized(request, expectedToken) {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([!-~]+)$/i.exec(header);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return false;

  // Compare fixed-size digests so the constant-time comparison never exposes token length.
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expectedToken)),
    crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(expected, supplied);
  }

  // The Web Crypto verify operation is a portable constant-time comparison for Node-based tests.
  const key = await crypto.subtle.importKey(
    'raw',
    expected,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const signature = await crypto.subtle.sign('HMAC', key, expected);
  return crypto.subtle.verify('HMAC', key, signature, supplied);
}

function measurementMeta(meta = {}) {
  const result = {};
  for (const name of [
    'duration',
    'changes',
    'rows_read',
    'rows_written',
    'size_after',
    'total_attempts',
  ]) {
    if (typeof meta[name] === 'number' && Number.isFinite(meta[name])) {
      result[name] = meta[name];
    }
  }
  for (const name of ['served_by_region', 'served_by_colo', 'served_by_primary']) {
    if (typeof meta[name] === (name === 'served_by_primary' ? 'boolean' : 'string')) {
      result[name] = meta[name];
    }
  }
  const sqlDuration = meta.timings?.sql_duration_ms;
  if (typeof sqlDuration === 'number' && Number.isFinite(sqlDuration)) {
    result.timings = { sql_duration_ms: sqlDuration };
  }
  return result;
}

export default {
  async fetch(request, env) {
    // Authenticate every path before inspecting a binding or executing a database operation.
    if (typeof env.BENCH_TOKEN !== 'string' || env.BENCH_TOKEN.length === 0) {
      return json({ ok: false, error: 'AUTH_UNAVAILABLE' }, 503);
    }
    try {
      if (!(await authorized(request, env.BENCH_TOKEN))) {
        return json({ ok: false, error: 'UNAUTHORIZED' }, 401, {
          'WWW-Authenticate': 'Bearer',
        });
      }
    } catch {
      return json({ ok: false, error: 'AUTH_UNAVAILABLE' }, 503);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/read' && url.pathname !== '/write') {
      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    }
    const operation = url.pathname.slice(1);
    const method = operation === 'read' ? 'GET' : 'POST';
    if (request.method !== method) {
      return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: method });
    }
    const target = url.searchParams.get('target') ?? 'source';
    if (
      (target !== 'source' && target !== 'control') ||
      (operation === 'write' && target !== 'source')
    ) {
      return json({ ok: false, error: 'INVALID_TARGET' }, 400);
    }

    const started = performance.now();
    const context = { operation, target, colo: request.cf?.colo ?? null };
    try {
      const database = target === 'source' ? env.DB : env.CONTROL;
      // Every request uses a new session and only one query, so reads always reach the primary.
      const session = database.withSession('first-primary');
      const sql =
        operation === 'write'
          ? 'UPDATE bench_probe SET writes = writes + 1 WHERE id = 1 RETURNING writes'
          : target === 'source'
            ? 'SELECT 1 AS present FROM bench_accounts WHERE id = 1'
            : 'SELECT 1 AS present';
      const result = await session.prepare(sql).all();
      const sqlWallMs = performance.now() - started;
      if (!result.success) {
        return json({ ok: false, ...context, sqlWallMs, error: 'D1_UNAVAILABLE' }, 503);
      }
      if (result.results?.length !== 1) {
        return json({ ok: false, ...context, sqlWallMs, error: 'PROBE_NOT_READY' }, 503);
      }
      // Never return query results, record contents, raw exceptions, SQL, or binding identifiers.
      return json({ ok: true, ...context, sqlWallMs, meta: measurementMeta(result.meta) });
    } catch {
      return json(
        {
          ok: false,
          ...context,
          sqlWallMs: performance.now() - started,
          error: 'D1_UNAVAILABLE',
        },
        503
      );
    }
  },
};
