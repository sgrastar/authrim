import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOG_PLANES, LOG_TYPES } from '../registry';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

function extractUnionValues(doc: string, typeName: string): string[] {
  const match = doc.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  if (!match) {
    throw new Error(`Missing ${typeName} union in API specification`);
  }

  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((value) => value[1]);
}

describe('logging registry documentation', () => {
  const apiSpec = readFileSync(
    resolve(repoRoot, 'private/docs/operations/logging-storage-api-spec-2026-05-19.md'),
    'utf8'
  );

  it('keeps API LogType values synchronized with the runtime registry', () => {
    expect(extractUnionValues(apiSpec, 'LogType')).toEqual([...LOG_TYPES]);
  });

  it('keeps API LogPlane values synchronized with the runtime registry', () => {
    expect(extractUnionValues(apiSpec, 'LogPlane')).toEqual([...LOG_PLANES]);
  });
});
