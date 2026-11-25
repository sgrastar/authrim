/**
 * Inventory of audit writes that land in the end-user (core) audit log.
 *
 * Admin operations belong in the admin audit log, and the platform's own events (a cron, an
 * outbox, a delivery) in the system log. This walks the TypeScript sources and lists every call
 * that writes a core audit row, so the admin and system ones can be found, moved and kept out,
 * and every call that writes a system event. The ar-management tests use it as a gate;
 * `pnpm run audit:core-writes` prints it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { resolveAuditEventFailureBehavior } from '@authrim/ar-lib-core/services/audit/event-classification';

export type AuditWriteHelper =
  | 'createAuditLogFromContext'
  | 'scheduleAuditLogFromContext'
  | 'createAuditLog'
  | 'writeLegacyAuditLog'
  /** A module's own audit function that forwards its arguments to one of the helpers. */
  | 'wrapper';

export interface AuditWriteSite {
  /** Repository-relative path with forward slashes. */
  file: string;
  line: number;
  helper: AuditWriteHelper;
  /** For a wrapper call: the wrapper's name. */
  via?: string;
  /** The literal action, a `*` pattern for a template, or `dynamic:<expression>`. */
  action: string;
  /** The literal resource type, or `dynamic:<expression>`. */
  resource: string;
  /** True when the action is a literal (or a template, as a pattern). */
  actionKnown: boolean;
  /**
   * Whether the end user the row is about is named: the resource is a user, or the metadata
   * literal carries `userId` / `user_id`. The core log links such a row to that user.
   */
  namesUser: boolean;
  /**
   * Whether the caller catches the helper's error and carries on (try/catch or a chained
   * .catch that neither rethrows nor returns); null when that depends on a condition.
   */
  callerSwallows: boolean | null;
  /** Whether the call passes its own audit ID (idempotent retries); null when not literal. */
  fixedId: boolean | null;
  /** Fail-closed classification of the literal action; null for a dynamic one. */
  failClosed: boolean | null;
  /**
   * Whether the row's actor is the platform itself: a literal `userId` of `system`, a scheduler
   * or a job. False for a literal user or admin actor and for the admin context helper; null
   * when the actor is dynamic or the write goes through a wrapper.
   */
  actorSystem: boolean | null;
}

/** One write to the system log (`logSystemEvent`). */
export interface SystemEventWriteSite {
  file: string;
  line: number;
  /** The literal source (`authrim/<surface>`), or `dynamic:<expression>`. */
  source: string;
  /** The literal action, or `dynamic:<expression>`. */
  action: string;
}

/** Literal `userId` values that mean the platform acted, not a person. */
const SYSTEM_ACTOR = /^(system|admin_job|[a-z0-9_-]*scheduler)$/u;

const HELPERS = new Set<string>([
  'createAuditLogFromContext',
  'scheduleAuditLogFromContext',
  'createAuditLog',
  'writeLegacyAuditLog',
]);

/**
 * Module-local audit functions that forward to a helper. Their call sites, not the forwarding
 * call inside them, say which action is written.
 */
interface WrapperSpec {
  file: string;
  name: string;
  actionArg: number;
  resource: string | { arg: number };
  metadataArg: number;
}

export const AUDIT_WRAPPERS: readonly WrapperSpec[] = [
  {
    file: 'packages/ar-management/src/admin-screens.ts',
    name: 'recordScreenAudit',
    actionArg: 1,
    resource: 'screen',
    metadataArg: 3,
  },
  {
    file: 'packages/ar-management/src/launchers.ts',
    name: 'recordAdminAudit',
    actionArg: 1,
    resource: 'application_launcher',
    metadataArg: 3,
  },
  {
    file: 'packages/ar-management/src/routes/directory-auth.ts',
    name: 'auditDirectoryAuthAction',
    actionArg: 1,
    resource: { arg: 2 },
    metadataArg: 5,
  },
];

/** Files that define the helpers themselves. */
const DEFINING_FILES = new Set(['packages/ar-lib-core/src/utils/audit-log.ts']);

function isTestPath(path: string): boolean {
  return (
    path.includes(`${sep}__tests__${sep}`) ||
    /\.(test|spec|mutation\.test|integration\.test)\.ts$/u.test(path) ||
    path.includes(`${sep}test-utils${sep}`)
  );
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.svelte-kit') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) listSourceFiles(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !isTestPath(path)) out.push(path);
  }
  return out;
}

function expressionValue(node: ts.Expression | undefined, source: ts.SourceFile): string {
  if (!node) return 'dynamic:<missing>';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `*${span.literal.text}`).join('');
  }
  return `dynamic:${node.getText(source).replace(/\s+/gu, ' ')}`;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** undefined: the node is not an object literal; null: the property is absent. */
function objectProperty(
  node: ts.Expression | undefined,
  name: string
): ts.Expression | null | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return null;
}

function isUndefined(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === 'undefined') ||
    ts.isVoidExpression(node) ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function idValue(node: ts.Expression | null | undefined): boolean | null {
  if (node === null) return false;
  if (node === undefined) return null;
  if (isUndefined(node)) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isTemplateExpression(node)) return true;
  return null;
}

/** Whether a metadata argument names an end user. A non-literal argument is not inspected. */
function metadataNamesUser(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  // `JSON.stringify({ ... })` for the entry forms.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText() === 'JSON.stringify'
  ) {
    return metadataNamesUser(node.arguments[0]);
  }
  if (!ts.isObjectLiteralExpression(node)) return false;
  return ['userId', 'user_id'].some((key) => {
    const value = objectProperty(node, key);
    return value !== null && value !== undefined && !isUndefined(value);
  });
}

/**
 * How a block ends: 'always' when its last statement throws or returns, 'never' when it has no
 * throw or return at all, 'sometimes' otherwise.
 */
function exits(block: ts.Block | ts.Expression): 'always' | 'never' | 'sometimes' {
  if (!ts.isBlock(block)) return 'never';
  const last = block.statements.at(-1);
  if (last && (ts.isThrowStatement(last) || ts.isReturnStatement(last))) return 'always';
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== block && ts.isFunctionLike(node))) return;
    if (ts.isThrowStatement(node) || ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return found ? 'sometimes' : 'never';
}

/**
 * Whether a `.catch` handler settles the promise: unlike a request handler's return, its return
 * resolves the chain. It fails the chain only by throwing or by returning a rejection; a returned
 * call may be either, so it is unknown.
 */
function catchHandlerSwallows(body: ts.ConciseBody): boolean | null {
  const rejects = (expression: ts.Expression | undefined): boolean | null => {
    if (!expression) return false;
    if (ts.isCallExpression(expression)) {
      return expression.expression.getText() === 'Promise.reject' ? true : null;
    }
    return false;
  };
  if (!ts.isBlock(body)) {
    const verdict = rejects(body);
    return verdict === null ? null : !verdict;
  }
  const last = body.statements.at(-1);
  if (last && ts.isThrowStatement(last)) return false;
  let throws = false;
  let unknown = false;
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isThrowStatement(node)) throws = true;
    if (ts.isReturnStatement(node)) {
      const verdict = rejects(node.expression);
      if (verdict === null) unknown = true;
      else if (verdict) throws = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (throws) return null;
  return unknown ? null : true;
}

function swallowsFrom(kind: 'always' | 'never' | 'sometimes'): boolean | null {
  return kind === 'never' ? true : kind === 'always' ? false : null;
}

function callerSwallows(call: ts.CallExpression): boolean | null {
  let node: ts.Node = call;
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) {
    node = node.parent;
  }
  // `helper(...).catch(handler)`
  if (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.name.text === 'catch' &&
    ts.isCallExpression(node.parent.parent)
  ) {
    const handler = node.parent.parent.arguments[0];
    if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
      return catchHandlerSwallows(handler.body);
    }
    return null;
  }
  // Inside the try block of the nearest try statement with a catch clause, in the same function.
  // A handler-wide catch that answers with an error response does not swallow the failure.
  for (let current: ts.Node | undefined = call; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
    const parent: ts.Node | undefined = current.parent;
    if (parent && ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) {
      return swallowsFrom(exits(parent.catchClause.block));
    }
  }
  return false;
}

function classify(action: string): boolean | null {
  if (action.startsWith('dynamic:')) return null;
  // A template keeps its literal head, which is what the prefix rules match on.
  const probe = action.includes('*') ? action.slice(0, action.indexOf('*')) : action;
  return resolveAuditEventFailureBehavior(probe).behavior === 'fail_closed_or_strong_retry';
}

/** The actor of an entry object: see `AuditWriteSite.actorSystem`. */
function actorSystemOf(entry: ts.Expression | undefined): boolean | null {
  const node = objectProperty(entry, 'userId');
  if (node === undefined || node === null) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return SYSTEM_ACTOR.test(node.text);
  return null;
}

function site(
  call: ts.CallExpression,
  source: ts.SourceFile,
  file: string,
  fields: Omit<AuditWriteSite, 'file' | 'line' | 'actionKnown' | 'callerSwallows' | 'failClosed'>
): AuditWriteSite {
  const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
  return {
    file,
    line: line + 1,
    ...fields,
    actionKnown: !fields.action.startsWith('dynamic:'),
    callerSwallows: callerSwallows(call),
    failClosed: classify(fields.action),
  };
}

function helperSite(
  call: ts.CallExpression,
  helper: AuditWriteHelper,
  source: ts.SourceFile,
  file: string
): AuditWriteSite {
  const args = call.arguments;
  if (helper === 'createAuditLogFromContext' || helper === 'scheduleAuditLogFromContext') {
    const resource = expressionValue(args[2], source);
    return site(call, source, file, {
      helper,
      action: expressionValue(args[1], source),
      resource,
      namesUser: resource === 'user' || metadataNamesUser(args[4]),
      fixedId: helper === 'createAuditLogFromContext' ? idValue(args[6] ?? null) : false,
      // The context helper writes the signed-in administrator.
      actorSystem: false,
    });
  }
  const entry = args[1];
  const actionNode = objectProperty(entry, 'action');
  const resourceNode = objectProperty(entry, 'resource');
  const describe = (node: ts.Expression | null | undefined, missing: string) =>
    node === undefined
      ? `dynamic:${entry ? entry.getText(source).replace(/\s+/gu, ' ').slice(0, 60) : missing}`
      : expressionValue(node ?? undefined, source);
  const resource = describe(resourceNode, '<entry>');
  return site(call, source, file, {
    helper,
    action: describe(actionNode, '<missing>'),
    resource,
    namesUser:
      resource === 'user' || metadataNamesUser(objectProperty(entry, 'metadata') ?? undefined),
    fixedId:
      entry && ts.isObjectLiteralExpression(entry) ? idValue(objectProperty(entry, 'id')) : null,
    actorSystem: actorSystemOf(entry),
  });
}

function wrapperSite(
  call: ts.CallExpression,
  wrapper: WrapperSpec,
  source: ts.SourceFile,
  file: string,
  innerSwallows: boolean | null
): AuditWriteSite {
  const args = call.arguments;
  const resource =
    typeof wrapper.resource === 'string'
      ? wrapper.resource
      : expressionValue(args[wrapper.resource.arg], source);
  const base = site(call, source, file, {
    helper: 'wrapper',
    via: wrapper.name,
    action: expressionValue(args[wrapper.actionArg], source),
    resource,
    namesUser: resource === 'user' || metadataNamesUser(args[wrapper.metadataArg]),
    fixedId: false,
    actorSystem: null,
  });
  // A wrapper that catches its own write carries on whatever its caller does.
  return {
    ...base,
    callerSwallows:
      innerSwallows === true
        ? true
        : innerSwallows === null
          ? base.callerSwallows === true
            ? true
            : null
          : base.callerSwallows,
  };
}

function isCoreModule(specifier: string): boolean {
  return (
    specifier === '@authrim/ar-lib-core' ||
    /(^|\/)audit-log(\.js)?$/u.test(specifier) ||
    /(^|\/)utils(\/index)?(\.js)?$/u.test(specifier)
  );
}

/** Names a file binds to the helpers, and namespaces it imports the core library as. */
function importedHelpers(source: ts.SourceFile): {
  names: Map<string, AuditWriteHelper>;
  namespaces: Set<string>;
} {
  const names = new Map<string, AuditWriteHelper>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (!isCoreModule((statement.moduleSpecifier as ts.StringLiteral).text)) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (HELPERS.has(imported)) names.set(element.name.text, imported as AuditWriteHelper);
    }
  }
  return { names, namespaces };
}

function calledHelper(
  call: ts.CallExpression,
  imports: ReturnType<typeof importedHelpers>
): AuditWriteHelper | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return imports.names.get(callee.text);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.namespaces.has(callee.expression.text) &&
    HELPERS.has(callee.name.text)
  ) {
    return callee.name.text as AuditWriteHelper;
  }
  return undefined;
}

/** The function declaration that encloses a node, if any. */
function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
  }
  return undefined;
}

export function inventoryCoreAuditWrites(
  repositoryRoot: string,
  packages: readonly string[] = ['packages']
): AuditWriteSite[] {
  const sites: AuditWriteSite[] = [];
  for (const base of packages) {
    for (const path of listSourceFiles(join(repositoryRoot, base))) {
      const file = relative(repositoryRoot, path).split(sep).join('/');
      if (DEFINING_FILES.has(file)) continue;
      const text = readFileSync(path, 'utf8');
      if (![...HELPERS].some((helper) => text.includes(helper))) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const imports = importedHelpers(source);
      if (imports.names.size === 0 && imports.namespaces.size === 0) continue;
      const wrappers = AUDIT_WRAPPERS.filter((wrapper) => wrapper.file === file);
      // First pass: whether each wrapper catches the write it forwards.
      const innerSwallows = new Map<string, boolean | null>();
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calledHelper(node, imports)) {
          const inside = enclosingFunctionName(node);
          if (inside && wrappers.some((wrapper) => wrapper.name === inside)) {
            innerSwallows.set(inside, callerSwallows(node));
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const helper = calledHelper(node, imports);
          const wrapper = ts.isIdentifier(node.expression)
            ? wrappers.find(
                (candidate) => candidate.name === (node.expression as ts.Identifier).text
              )
            : undefined;
          if (helper) {
            // The forwarding call inside a known wrapper is listed through the wrapper's calls.
            const inside = enclosingFunctionName(node);
            if (!wrappers.some((candidate) => candidate.name === inside)) {
              sites.push(helperSite(node, helper, source, file));
            }
          } else if (wrapper) {
            sites.push(
              wrapperSite(node, wrapper, source, file, innerSwallows.get(wrapper.name) ?? null)
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Every call of `logSystemEvent` (imported from the core library) in the packages. */
export function inventorySystemEventWrites(
  repositoryRoot: string,
  packages: readonly string[] = ['packages']
): SystemEventWriteSite[] {
  const sites: SystemEventWriteSite[] = [];
  for (const base of packages) {
    for (const path of listSourceFiles(join(repositoryRoot, base))) {
      const file = relative(repositoryRoot, path).split(sep).join('/');
      if (file === 'packages/ar-lib-core/src/utils/system-event-log.ts') continue;
      const text = readFileSync(path, 'utf8');
      if (!text.includes('logSystemEvent')) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
        if (!isCoreModule((statement.moduleSpecifier as ts.StringLiteral).text)) continue;
        const bindings = statement.importClause.namedBindings;
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === 'logSystemEvent')
              names.add(element.name.text);
          }
        }
      }
      if (names.size === 0) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          names.has(node.expression.text)
        ) {
          const input = node.arguments[1];
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const field = (name: string) => {
            const value = objectProperty(input, name);
            return value === undefined || value === null
              ? `dynamic:${input ? input.getText(source).replace(/\s+/gu, ' ').slice(0, 60) : '<missing>'}`
              : expressionValue(value, source);
          };
          sites.push({ file, line: line + 1, source: field('source'), action: field('action') });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Whether a site's action (a literal or a `*` pattern) can be the given action. */
export function siteActionMatches(site: AuditWriteSite, action: string): boolean {
  if (!site.actionKnown) return false;
  if (!site.action.includes('*')) return site.action === action;
  const pattern = site.action
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^]*');
  return new RegExp(`^${pattern}$`, 'u').test(action);
}

/**
 * Counts, for each literal action, the source files outside the given sites that also contain
 * that exact string. A non-zero count means another writer (an event constant, another package)
 * may emit the same action, so a read-time filter on it is not proof of an admin origin.
 */
export function findOtherOccurrences(
  repositoryRoot: string,
  actions: readonly string[],
  ownFiles: ReadonlySet<string>
): Map<string, string[]> {
  const wanted = new Set(actions.filter((action) => !action.includes('*')));
  const hits = new Map<string, string[]>();
  for (const path of listSourceFiles(join(repositoryRoot, 'packages'))) {
    const file = relative(repositoryRoot, path).split(sep).join('/');
    if (ownFiles.has(file)) continue;
    const text = readFileSync(path, 'utf8');
    for (const action of wanted) {
      if (
        text.includes(`'${action}'`) ||
        text.includes(`"${action}"`) ||
        text.includes(`\`${action}\``)
      ) {
        const list = hits.get(action) ?? [];
        list.push(file);
        hits.set(action, list);
      }
    }
  }
  return hits;
}
