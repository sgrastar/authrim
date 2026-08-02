import type { R2Bucket, WorkerLoaderWorkerCode } from '@cloudflare/workers-types';

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_MODULES = 64;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_MODULE = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)\S{1,240}\.(?:js|cjs|json|txt)$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMPATIBILITY_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_COMPATIBILITY_FLAG = /^[a-z][a-z0-9_]{0,63}$/u;

export interface PluginWorkerCodeTarget {
  pluginId: string;
  codeObjectKey: string;
  codeSha256: string;
}

export interface PluginWorkerCodeResolver {
  resolve(target: PluginWorkerCodeTarget): Promise<WorkerLoaderWorkerCode>;
}

interface PluginWorkerBundle {
  schemaVersion: 1;
  pluginId: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, string>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseBundle(value: unknown, expectedPluginId: string): PluginWorkerBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_worker_bundle_invalid');
  }
  const bundle = value as Record<string, unknown>;
  if (
    !exactKeys(bundle, [
      'compatibilityDate',
      'compatibilityFlags',
      'mainModule',
      'modules',
      'pluginId',
      'schemaVersion',
    ]) ||
    bundle.schemaVersion !== 1 ||
    bundle.pluginId !== expectedPluginId ||
    typeof bundle.compatibilityDate !== 'string' ||
    !COMPATIBILITY_DATE.test(bundle.compatibilityDate) ||
    typeof bundle.mainModule !== 'string' ||
    !SAFE_MODULE.test(bundle.mainModule) ||
    !Array.isArray(bundle.compatibilityFlags) ||
    bundle.compatibilityFlags.length > 16 ||
    bundle.compatibilityFlags.some(
      (flag) => typeof flag !== 'string' || !SAFE_COMPATIBILITY_FLAG.test(flag)
    ) ||
    !bundle.modules ||
    typeof bundle.modules !== 'object' ||
    Array.isArray(bundle.modules)
  ) {
    throw new Error('plugin_worker_bundle_invalid');
  }
  const modules = bundle.modules as Record<string, unknown>;
  const names = Object.keys(modules);
  if (
    names.length < 1 ||
    names.length > MAX_MODULES ||
    !names.includes(bundle.mainModule) ||
    names.some((name) => !SAFE_MODULE.test(name) || typeof modules[name] !== 'string')
  ) {
    throw new Error('plugin_worker_bundle_invalid');
  }
  return {
    schemaVersion: 1,
    pluginId: bundle.pluginId,
    compatibilityDate: bundle.compatibilityDate,
    compatibilityFlags: [...new Set(bundle.compatibilityFlags as string[])].sort(),
    mainModule: bundle.mainModule,
    modules: Object.fromEntries(names.sort().map((name) => [name, modules[name] as string])),
  };
}

export class R2PluginWorkerCodeResolver implements PluginWorkerCodeResolver {
  constructor(private readonly bucket: R2Bucket | undefined) {}

  async resolve(target: PluginWorkerCodeTarget): Promise<WorkerLoaderWorkerCode> {
    if (!this.bucket) throw new Error('plugin_worker_code_store_unavailable');
    if (
      !SAFE_ID.test(target.pluginId) ||
      !SHA256_HEX.test(target.codeSha256) ||
      target.codeObjectKey !== `plugins/${target.pluginId}/${target.codeSha256}.json`
    ) {
      throw new Error('plugin_worker_code_reference_invalid');
    }
    const object = await this.bucket.get(target.codeObjectKey);
    if (!object) throw new Error('plugin_worker_code_not_found');
    if (typeof object.size === 'number' && object.size > MAX_BUNDLE_BYTES) {
      throw new Error('plugin_worker_bundle_too_large');
    }
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error('plugin_worker_bundle_too_large');
    const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (digest !== target.codeSha256) throw new Error('plugin_worker_bundle_digest_mismatch');
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      ) as unknown;
    } catch {
      throw new Error('plugin_worker_bundle_invalid');
    }
    const bundle = parseBundle(parsed, target.pluginId);
    return {
      compatibilityDate: bundle.compatibilityDate,
      compatibilityFlags: bundle.compatibilityFlags,
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      globalOutbound: null,
    };
  }
}
