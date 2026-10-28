import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  SAML_DR_WRITER_COMPONENTS,
  samlDrWriterContractDigest,
  samlDrWriterSurfaces,
  type SamlDrWriterComponent,
} from '../saml-dr-writer-contract';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
function array(path: string, name: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name ||
        !declaration.initializer
      )
        continue;
      const expression = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (
        !ts.isArrayLiteralExpression(expression) ||
        expression.elements.some((element) => !ts.isStringLiteral(element))
      )
        throw new Error('inventory must be a literal string array');
      return expression.elements.map((element) => (element as ts.StringLiteral).text);
    }
  }
  throw new Error(`Missing source inventory ${path}:${name}`);
}
function objectArrays(path: string, name: string): Record<string, string[]> {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name ||
        !declaration.initializer
      )
        continue;
      const expression = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (!ts.isObjectLiteralExpression(expression))
        throw new Error('inventory must be a literal object');
      return Object.fromEntries(
        expression.properties.map((property) => {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name) ||
            !ts.isArrayLiteralExpression(property.initializer)
          )
            throw new Error('inventory must contain literal arrays');
          return [
            property.name.text,
            property.initializer.elements.map((element) => {
              if (!ts.isStringLiteral(element))
                throw new Error('inventory member must be a string');
              return element.text;
            }),
          ];
        })
      );
    }
  }
  throw new Error(`Missing source inventory ${path}:${name}`);
}

const owned: Partial<Record<SamlDrWriterComponent, string[]>> = {
  'ar-discovery': ['index.ts'],
  'ar-userinfo': ['index.ts'],
  'ar-router': ['index.ts'],
  'ar-token': ['index.ts', 'entrypoints/AgentDownscopeEntrypoint.ts'],
  'ar-bridge': ['index.ts'],
  'ar-async': ['index.ts'],
  'ar-policy': ['index.ts'],
  'ar-vc': ['index.ts', 'entrypoints/VCIssuerEntrypoint.ts'],
  'ar-agent-access': ['platform/cloudflare/worker.ts', 'platform/cloudflare/mcp-agent.ts'],
  'ar-plugin-runner': ['worker.ts', 'resource-bindings.ts'],
};

describe('installed SAML DR writer capability contract', () => {
  it.each(SAML_DR_WRITER_COMPONENTS)(
    'publishes immutable source-defined coverage for %s',
    async (component) => {
      const surfaces = samlDrWriterSurfaces(component);
      expect(surfaces.length).toBeGreaterThan(0);
      expect(Object.isFrozen(surfaces)).toBe(true);
      expect(new Set(surfaces).size).toBe(surfaces.length);
      expect(await samlDrWriterContractDigest(component)).toMatch(/^[a-f0-9]{64}$/u);
    }
  );
  it.each(Object.entries(owned))(
    'matches the concrete Worker entrypoint arrays for %s',
    (name, paths) => {
      const component = name as SamlDrWriterComponent;
      const expected = paths.flatMap((path) =>
        array(`packages/${component}/src/${path}`, 'SAML_DR_WRITER_SURFACES').map(
          (surface) => `guarded:${surface}`
        )
      );
      const observed = samlDrWriterSurfaces(component).filter(
        (surface) => surface.startsWith('guarded:') && !surface.startsWith('guarded:do:')
      );
      expect([...observed].sort()).toEqual(expected.sort());
    }
  );
  it('pins the new log RPCs and signed bootstrap probe to their literal guarded/read-only catalogues', () => {
    const log = 'packages/ar-lib-core/src/entrypoints/LogArchiveWriteEntrypoint.ts';
    expect(
      samlDrWriterSurfaces('ar-lib-core')
        .filter((surface) => surface.includes('LogArchiveWriteEntrypoint.'))
        .sort()
    ).toEqual(
      [
        ...array(log, 'SAML_DR_WRITER_SURFACES').map((surface) => `guarded:${surface}`),
        ...array(log, 'SAML_DR_READ_ONLY_SURFACES').map((surface) => `read-only:${surface}`),
      ].sort()
    );
    expect(
      array(
        'packages/ar-lib-core/src/entrypoints/RuntimeSmokeEntrypoint.ts',
        'SAML_DR_WRITER_SURFACES'
      ).map((surface) => `guarded:${surface}`)
    ).toEqual(
      samlDrWriterSurfaces('ar-management').filter((surface) =>
        surface.includes('RuntimeSmokeEntrypoint.probeLogArchive')
      )
    );
  });
  it('pins plugin read-only exemptions and Management coordinator exceptions explicitly', () => {
    expect(
      samlDrWriterSurfaces('ar-router').filter((surface) => surface.startsWith('coordinator:'))
    ).toEqual(
      array('packages/ar-router/src/index.ts', 'SAML_DR_COORDINATOR_SURFACES')
        .map((surface) => `coordinator:${surface}`)
        .sort()
    );
    expect(
      samlDrWriterSurfaces('ar-plugin-runner').filter((surface) => surface.startsWith('read-only:'))
    ).toEqual(
      array('packages/ar-plugin-runner/src/worker.ts', 'SAML_DR_READ_ONLY_SURFACES')
        .map((surface) => `read-only:${surface}`)
        .sort()
    );
    const expected = [
      ...array('packages/ar-management/src/index.ts', 'SAML_DR_WRITER_SURFACES').map(
        (surface) => `guarded:${surface}`
      ),
      ...array('packages/ar-management/src/index.ts', 'SAML_DR_COORDINATOR_SURFACES').map(
        (surface) => `coordinator:${surface}`
      ),
      ...array('packages/ar-management/src/index.ts', 'SAML_DR_READ_ONLY_SURFACES').map(
        (surface) => `read-only:${surface}`
      ),
    ].sort();
    expect(samlDrWriterSurfaces('ar-management')).toEqual(expected);
  });
});

it('pins authoritative DO guarded and snapshot capabilities to their concrete source catalogues', () => {
  for (const [className, constant] of [
    ['KeyManager', 'SAML_DR_KEY_MANAGER_SURFACE'],
    ['SessionRevocationStore', 'SAML_DR_SESSION_REVOCATION_SURFACE'],
  ] as const) {
    const actual = objectArrays(
      `packages/ar-lib-core/src/durable-objects/${className}.ts`,
      constant
    );
    const expected = Object.entries(actual)
      .flatMap(([category, methods]) =>
        methods.map((method) => `${category}:do:${className}.${method}`)
      )
      .sort();
    expect(
      samlDrWriterSurfaces('ar-lib-core').filter((surface) => surface.includes(`:do:${className}.`))
    ).toEqual(expected);
  }
});
it('pins every guarded, coordinator and read-only Control method to its actual inventory', () => {
  const actual = objectArrays('packages/ar-control/src/index.ts', 'SAML_DR_CONTROL_SURFACE');
  const expected = Object.entries(actual)
    .flatMap(([category, methods]) =>
      methods.map(
        (method) =>
          `${category}:${method === 'fetch' || method === 'scheduled' ? method : `rpc:ControlWorker.${method}`}`
      )
    )
    .sort();
  expect(
    samlDrWriterSurfaces('ar-control').filter(
      (surface) => !surface.includes(':rpc:SamlDrMutationEntrypoint.')
    )
  ).toEqual(expected);
});
