import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const directory = path.dirname(fileURLToPath(import.meta.url));

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      void Promise.resolve(promise).catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

export async function createCloudClient({ accountId, runDir, log, authFile: customAuthFile }) {
  const option = (_name, fallback) => customAuthFile ?? fallback;
  const cleanMessage = (value) =>
    String(value)
      .replace(/https?:\/\/\S+/g, '[URL]')
      .slice(0, 400);
  let token = process.env.CLOUDFLARE_API_TOKEN;
  const authFile = token
    ? null
    : option(
        'auth-file',
        process.platform === 'darwin'
          ? path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml')
          : path.join(homedir(), '.config/.wrangler/config/default.toml')
      );
  let tokenExpiresAt = Infinity;
  async function readOAuthFile() {
    const config = await readFile(authFile, 'utf8');
    token = config.match(/^oauth_token\s*=\s*"([^"\n]+)"/m)?.[1];
    tokenExpiresAt = Date.parse(config.match(/^expiration_time\s*=\s*"([^"\n]+)"/m)?.[1] ?? '');
    if (!token || !Number.isFinite(tokenExpiresAt)) {
      throw new Error('Wrangler OAuth file is missing a token or expiration time');
    }
  }
  if (authFile) await readOAuthFile();
  if (!token)
    throw new Error('Run pnpm exec wrangler whoami to refresh OAuth, or set CLOUDFLARE_API_TOKEN');

  let authRefresh;
  let nextAuthCheckAt = 0;
  let lastApiStartedAt = 0;
  async function ensureToken(force = false, signal) {
    signal?.throwIfAborted();
    if (!authFile || (!force && Date.now() < Math.min(tokenExpiresAt - 60000, nextAuthCheckAt)))
      return;
    if (authRefresh) return abortable(authRefresh, signal);
    const pendingRefresh = (async () => {
      // Pick up a token refreshed by another Wrangler process before approaching expiry.
      await readOAuthFile();
      nextAuthCheckAt = Date.now() + 30000;
      if (!force && tokenExpiresAt > Date.now()) return;
      const executable = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
      const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
      // Environment credentials bypass Wrangler's stored-OAuth refresh path.
      for (const name of [
        'CLOUDFLARE_API_TOKEN',
        'CF_API_TOKEN',
        'CLOUDFLARE_API_KEY',
        'CF_API_KEY',
      ])
        delete env[name];
      const child = spawn(process.execPath, [executable, 'whoami'], {
        cwd: runDir,
        env,
        stdio: 'ignore',
        timeout: 60000,
      });
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      if (code !== 0) throw new Error('Wrangler could not refresh stored OAuth credentials');
      await readOAuthFile();
      if (tokenExpiresAt <= Date.now()) throw new Error('Stored OAuth token remains expired');
      log('Reloaded Wrangler OAuth credentials');
    })();
    authRefresh = pendingRefresh;
    // Cancel a caller's wait without starting duplicate OAuth refresh processes.
    void pendingRefresh.then(
      () => {
        if (authRefresh === pendingRefresh) authRefresh = undefined;
      },
      () => {
        if (authRefresh === pendingRefresh) authRefresh = undefined;
      }
    );
    await abortable(pendingRefresh, signal);
  }

  async function api(
    endpoint,
    { method = 'GET', body, timeoutMs = 120000, retry = method === 'GET', signal } = {}
  ) {
    let transientAttempts = 0;
    let authRetried = false;
    for (;;) {
      signal?.throwIfAborted();
      await ensureToken(false, signal);
      await delay(Math.max(0, lastApiStartedAt + 300 - Date.now()), undefined, { signal });
      signal?.throwIfAborted();
      lastApiStartedAt = Date.now();
      let response;
      try {
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/${endpoint}`,
          {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          }
        );
        signal?.throwIfAborted();
        if (response.status === 204) return null;
        const json = await abortable(
          response.json().catch((error) => {
            signal?.throwIfAborted();
            if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
            return null;
          }),
          signal
        );
        signal?.throwIfAborted();
        if (response.status === 401 && authFile && !authRetried) {
          authRetried = true;
          await ensureToken(true, signal);
          continue;
        }
        if (!response.ok || !json || json.success === false) {
          const error = new Error(
            `API ${method} ${endpoint.split('/').at(-1)} HTTP ${response.status}: ${cleanMessage(JSON.stringify(json?.errors ?? { error: 'Invalid API response' }))}`
          );
          error.status = response.status;
          throw error;
        }
        return json.result;
      } catch (error) {
        signal?.throwIfAborted();
        const transient =
          [408, 429, 500, 502, 503, 504].includes(error.status) ||
          error.name === 'TypeError' ||
          error.name === 'TimeoutError';
        if (!retry || !transient || transientAttempts >= 3) throw error;
        const retryAfter = Number(response?.headers.get('retry-after'));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** transientAttempts;
        if (waitMs > 30000) throw error; // Do not silently abandon an export's polling lease.
        transientAttempts++;
        log(
          `Retrying transient API failure (${transientAttempts}/3): ${cleanMessage(error.message)}`
        );
        await delay(waitMs, undefined, { signal });
      }
    }
  }

  async function wrangler(commandArgs, logName) {
    await ensureToken();
    const executable = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
    const child = spawn(process.execPath, [executable, ...commandArgs], {
      cwd: runDir,
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: token,
        WRANGLER_LOG_PATH: path.join(runDir, 'wrangler.log'),
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output += chunk;
      });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await writeFile(path.join(runDir, `${logName}.txt`), output, { mode: 0o600 });
    if (code !== 0)
      throw new Error(`Wrangler ${commandArgs[0]} failed: ${cleanMessage(output.slice(-1500))}`);
    return output;
  }

  return { api, wrangler };
}
