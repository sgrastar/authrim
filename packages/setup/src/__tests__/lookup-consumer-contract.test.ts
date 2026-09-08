import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKER_COMPONENTS,
  getRequiredDataRolesForComponent,
  getBuiltinD1BindingsForComponent,
} from '../core/naming.js';
import { getSecretNamesForWorker } from '../core/secrets.js';
import { lookupHmacRotationTargetComponents } from '../cli/commands/lookup-hmac-rotate.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const slots = ['LOOKUP_HMAC_KEY_SLOT_A', 'LOOKUP_HMAC_KEY_SLOT_B'];

async function runtimeSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.name !== '__tests__')
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return runtimeSources(path);
        if (!entry.name.endsWith('.ts') || /\.(test|spec)\.ts$/.test(entry.name)) return [];
        return [await readFile(path, 'utf8')];
      })
  );
  return sources.flat();
}

describe('Lookup consumer deployment contract', () => {
  it('declares and distributes keys for runtime account lookup consumers', async () => {
    for (const component of WORKER_COMPONENTS) {
      // Shared library helpers are deployed by their callers, not by the DO entry point.
      if (component === 'ar-lib-core') continue;
      const sources = await runtimeSources(join(root, 'packages', component, 'src'));
      const consumesLookup = sources.some((source) =>
        /\b(?:resolveAccountDataContext|resolveAccountDataContextByIdentifier|resolveCustomClaimRuntimeSourcesFromEnv)\s*\(/.test(
          source
        )
      );
      if (!consumesLookup) continue;
      const manifest = JSON.parse(
        await readFile(
          join(root, 'packages', component, 'authrim.worker-capabilities.json'),
          'utf8'
        )
      );
      expect(manifest.lookupBlindIndex, component).toBe(true);
      expect(getSecretNamesForWorker(component), component).toEqual(expect.arrayContaining(slots));
    }
  });

  it('keeps capability declarations, deployment, rotation, and Control verification in sync', async () => {
    const consumers: string[] = [];
    for (const component of WORKER_COMPONENTS) {
      const manifest = JSON.parse(
        await readFile(
          join(root, 'packages', component, 'authrim.worker-capabilities.json'),
          'utf8'
        )
      );
      if (!manifest.lookupBlindIndex) continue;
      consumers.push(component);
      expect(manifest.requiredDataRoles, component).toContain('lookup');
      expect(getRequiredDataRolesForComponent(component), component).toContain('lookup');
      expect(getBuiltinD1BindingsForComponent(component), component).toContain('LOOKUP_DB');
      for (const name of slots) {
        expect(manifest.secrets, component).toContainEqual(
          expect.objectContaining({ name, required: name.endsWith('_A') })
        );
        expect(getSecretNamesForWorker(component), component).toContain(name);
      }
    }
    expect(lookupHmacRotationTargetComponents().sort()).toEqual(consumers.sort());
    const verifier = await readFile(
      join(root, 'packages/ar-control/src/lookup-hmac-candidate-verifier.ts'),
      'utf8'
    );
    const bindings = verifier
      .split('export const LOOKUP_HMAC_VERIFICATION_BINDINGS = {')[1]
      .split('} as const')[0];
    const verified = [...bindings.matchAll(/'(ar-[a-z-]+)'\s*:/g)].map((match) => match[1]);
    expect(verified.sort()).toEqual(consumers.sort());
  });
});
