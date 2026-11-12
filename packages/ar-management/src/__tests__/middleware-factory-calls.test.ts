import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * A middleware FACTORY (a function that returns `(c, next) => …`) passed to a route registration
 * without being called is a silent bug: Hono invokes it as the middleware, it returns a function
 * instead of a Response and never calls `next`, so the request ends as an empty 200 and the handler
 * behind it never runs (the guard it was meant to be does nothing). This scans every package's
 * non-test sources for that mistake: the factories are found from their own definitions, and any
 * of them appearing as a bare identifier among the arguments of `app.get/post/put/patch/delete/
 * use/all/on(…)` is reported.
 */
const PACKAGES = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.svelte-kit', '__tests__', '.wrangler']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'use', 'all', 'on']);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.ts$/.test(path) && !/\.(test|spec|d)\.ts$/.test(path)) out.push(path);
  }
  return out;
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Whether the node is a function taking `(c, next)`: a middleware. */
function isMiddlewareFunction(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parameters.length >= 2 &&
    ts.isIdentifier(node.parameters[1].name) &&
    node.parameters[1].name.text === 'next'
  );
}

/** Whether the function body returns a middleware function (it is a factory). */
function returnsMiddleware(fn: ts.FunctionLikeDeclaration): boolean {
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return isMiddlewareFunction(body);
  let found = false;
  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement) && isMiddlewareFunction(statement.expression)) found = true;
  }
  return found;
}

/** Top-level function-like definitions of a file, with whether each is a factory. */
function localDefinitions(file: ts.SourceFile): Map<string, boolean> {
  const defined = new Map<string, boolean>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      defined.set(
        statement.name.text,
        returnsMiddleware(statement) && !isPlainMiddleware(statement)
      );
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const init = declaration.initializer;
        defined.set(
          declaration.name.text,
          init !== undefined &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            !isMiddlewareFunction(init) &&
            returnsMiddleware(init)
        );
      }
    }
  }
  return defined;
}

function isPlainMiddleware(fn: ts.FunctionDeclaration): boolean {
  return (
    fn.parameters.length >= 2 &&
    ts.isIdentifier(fn.parameters[1].name) &&
    fn.parameters[1].name.text === 'next'
  );
}

const parsed = sources(PACKAGES).map((path) => ({ path, file: parse(path) }));

function exportedFactories(units: Array<{ file: ts.SourceFile }>): Set<string> {
  const factories = new Set<string>();
  for (const { file } of units) {
    for (const statement of file.statements) {
      const exported = ts
        .getModifiers(statement as ts.HasModifiers)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        returnsMiddleware(statement) &&
        !isPlainMiddleware(statement)
      ) {
        factories.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (
            ts.isIdentifier(declaration.name) &&
            init &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            !isMiddlewareFunction(init) &&
            returnsMiddleware(init)
          ) {
            factories.add(declaration.name.text);
          }
        }
      }
    }
  }
  return factories;
}

/**
 * Route registrations that pass a factory uncalled, as `file:line name`. A name is resolved by
 * symbol: an import (also under an alias, `import { f as g }`) of a known factory, a namespace
 * member (`core.f` with `import * as core`), or a definition in the same file, which decides for
 * itself whether the name is a factory (a local plain `(c, next)` middleware with a factory's name
 * is not).
 */
function uncalledFactories(
  units: Array<{ path: string; file: ts.SourceFile }>,
  factories: ReadonlySet<string>
): string[] {
  const found: string[] = [];
  for (const { path, file } of units) {
    const defined = localDefinitions(file);
    const factoryByLocalName = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      const bindings = statement.importClause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (factories.has(imported)) factoryByLocalName.set(element.name.text, imported);
        }
      }
    }
    for (const [name, isFactory] of defined) {
      if (isFactory) factoryByLocalName.set(name, name);
      else factoryByLocalName.delete(name);
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ROUTE_METHODS.has(node.expression.name.text)
      ) {
        for (const argument of node.arguments) {
          let name: string | undefined;
          if (ts.isIdentifier(argument)) name = factoryByLocalName.get(argument.text);
          else if (
            ts.isPropertyAccessExpression(argument) &&
            ts.isIdentifier(argument.expression) &&
            namespaces.has(argument.expression.text) &&
            factories.has(argument.name.text)
          ) {
            name = argument.name.text;
          }
          if (name) {
            const { line } = file.getLineAndCharacterOfPosition(argument.getStart());
            found.push(`${path.slice(PACKAGES.length + 1)}:${line + 1} ${argument.getText()}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

const FACTORIES = new Set(['requireSystemAdmin', 'requireAdminPermissions', 'adminAuthMiddleware']);
const sample = (text: string) => [
  {
    path: `${PACKAGES}/sample/src/routes.ts`,
    file: ts.createSourceFile('routes.ts', text, ts.ScriptTarget.Latest, true),
  },
];
const report = (text: string) => uncalledFactories(sample(text), FACTORIES);

describe('middleware factories in route registrations', () => {
  const factories = exportedFactories(parsed);

  it('finds the factories this check is about', () => {
    for (const name of [
      'requireSystemAdmin',
      'requireAdminPermissions',
      'requireAnyRole',
      'adminAuthMiddleware',
      'rateLimitMiddleware',
    ]) {
      expect(factories.has(name)).toBe(true);
    }
  });

  // Walks the syntax tree of every route file in the repository: a few seconds on CI under
  // coverage, more than the default 5 s there.
  it('passes none of them to a route uncalled', { timeout: 60_000 }, () => {
    expect(uncalledFactories(parsed, factories)).toEqual([]);
  });

  describe('the detector itself', () => {
    const importOf = "import { requireSystemAdmin } from '@authrim/ar-lib-core';\n";
    it('reports a bare factory, an aliased one and a namespace member', () => {
      expect(report(importOf + 'app.get("/x", requireSystemAdmin, h);')).toHaveLength(1);
      expect(
        report(
          "import { requireSystemAdmin as guard } from '@authrim/ar-lib-core';\napp.get('/x', guard, h);"
        )
      ).toHaveLength(1);
      expect(
        report(
          "import * as core from '@authrim/ar-lib-core';\napp.use('/x', core.requireSystemAdmin);"
        )
      ).toHaveLength(1);
      expect(
        report(
          'function requireAdminPermissions(list) { return async (c, next) => next(); }\napp.post("/x", requireAdminPermissions, h);'
        )
      ).toHaveLength(1);
    });

    it('accepts the called forms and a local plain middleware that shares a factory’s name', () => {
      expect(report(importOf + 'app.get("/x", requireSystemAdmin(), h);')).toEqual([]);
      expect(
        report(
          "import * as core from '@authrim/ar-lib-core';\napp.use('/x', core.requireSystemAdmin());"
        )
      ).toEqual([]);
      expect(
        report(
          'async function adminAuthMiddleware(c, next) { await next(); }\napp.use("/x", adminAuthMiddleware);'
        )
      ).toEqual([]);
      expect(
        report(
          "import { requireSystemAdmin } from '@authrim/ar-lib-core';\nconst guard = requireSystemAdmin();\napp.get('/x', guard, h);"
        )
      ).toEqual([]);
    });
  });
});
