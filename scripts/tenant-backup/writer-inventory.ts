import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface BackupWriterCandidate {
  source: string;
  sourceSha256: string;
  line: number;
  method: string;
  receiver: string;
  firstArgument: string | null;
  enclosingFunction: string | null;
  keyEvidence?: { kind: 'literal' | 'prefix'; value: string } | { kind: 'dynamic' };
  review: 'unreviewed';
  receiverEvidence?: { constructor: string; declarationLine: number };
}

/** A local declaration hint, never a reason to remove a call from the review queue. */
function receiverEvidence(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
  file: ts.SourceFile
): BackupWriterCandidate['receiverEvidence'] {
  if (!ts.isIdentifier(receiver)) return undefined;
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return undefined;
  const initializer = declaration.initializer;
  if (
    !initializer ||
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return undefined;
  }
  const constructor = initializer.expression;
  if (!['Map', 'Set', 'URLSearchParams', 'Headers'].includes(constructor.text)) return undefined;
  // noLib leaves built-ins unresolved; a local/imported name must not masquerade as one.
  if (checker.getSymbolAtLocation(constructor)) return undefined;
  return {
    constructor: constructor.text,
    declarationLine: file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1,
  };
}

// Bind lexical symbols inside this source only. Do not resolve imports, load dependencies,
// or run application code. This lets a parameter/let shadow an outer constant correctly.
function localChecker(file: ts.SourceFile): ts.TypeChecker {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file.fileName ? file : undefined),
    getDefaultLibFileName: () => '/unused.d.ts',
    writeFile: () => {
      throw new Error('backup_inventory_must_not_emit');
    },
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === file.fileName,
    readFile: (name) => (name === file.fileName ? file.text : undefined),
  };
  return ts.createProgram([file.fileName], { noLib: true, noResolve: true }, host).getTypeChecker();
}

function keyEvidence(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>()
): NonNullable<BackupWriterCandidate['keyEvidence']> {
  if (!expression || seen.has(expression) || seen.size >= 32) return { kind: 'dynamic' };
  const next = new Set(seen).add(expression);
  if (ts.isStringLiteralLike(expression)) return { kind: 'literal', value: expression.text };
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return keyEvidence(expression.expression, checker, next);
  }
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return keyEvidence(declaration.initializer, checker, next);
    }
    return { kind: 'dynamic' };
  }
  if (ts.isTemplateExpression(expression)) {
    let prefix = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = keyEvidence(span.expression, checker, next);
      if (value.kind === 'dynamic')
        return prefix ? { kind: 'prefix', value: prefix } : { kind: 'dynamic' };
      prefix += value.value;
      if (value.kind === 'prefix') return { kind: 'prefix', value: prefix };
      prefix += span.literal.text;
    }
    return { kind: 'literal', value: prefix };
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = keyEvidence(expression.left, checker, next);
    if (left.kind !== 'literal') return left;
    const right = keyEvidence(expression.right, checker, next);
    if (right.kind === 'dynamic')
      return left.value ? { kind: 'prefix', value: left.value } : { kind: 'dynamic' };
    return { kind: right.kind, value: left.value + right.value };
  }
  return { kind: 'dynamic' };
}

// Include SQL reads: query/queryOne can execute mutations with RETURNING. RPC names do not
// reliably distinguish reads from writes (e.g. a key getter may initialize or rotate a key).
const candidateMethods = new Set([
  'put',
  'delete',
  'deleteAll',
  'execute',
  'exec',
  'run',
  'batch',
  'prepare',
  'query',
  'queryOne',
  'transaction',
  'transactionSync',
  'createMultipartUpload',
  'resumeMultipartUpload',
  'uploadPart',
  'complete',
  'abort',
]);

function functionName(node: ts.Node, file: ts.SourceFile): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      if (parent.name) return parent.name.getText(file);
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText(file);
    }
  }
  return null;
}

/**
 * Syntactic review queue, NOT proof of complete writer interception. Keep aliases, dynamic
 * keys and computed methods visible rather than claiming ownership from spelling. Map.delete
 * and read-only RPC false positives must be reviewed. Receiver declaration hints never exclude
 * candidates: even a built-in instance can have an overridden method. Free-function wrappers, JS/Svelte source,
 * generated SQL and externally executed plugins require separate review.
 */
export function inspectBackupWriterCandidates(
  source: string,
  path: string
): BackupWriterCandidate[] {
  const file = ts.createSourceFile(
    '/inventory/input.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let checker: ts.TypeChecker | undefined;
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const result: BackupWriterCandidate[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : '<computed>';
        if (candidateMethods.has(method) || method.endsWith('Rpc') || method === '<computed>') {
          const receiverHint = receiverEvidence(
            callee.expression,
            (checker ??= localChecker(file)),
            file
          );
          result.push({
            source: path,
            sourceSha256,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            method,
            receiver: callee.expression.getText(file),
            firstArgument: node.arguments[0]?.getText(file) ?? null,
            enclosingFunction: functionName(node, file),
            ...(['put', 'delete', 'createMultipartUpload', 'resumeMultipartUpload'].includes(method)
              ? { keyEvidence: keyEvidence(node.arguments[0], (checker ??= localChecker(file))) }
              : {}),
            review: 'unreviewed',
            ...(receiverHint ? { receiverEvidence: receiverHint } : {}),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

/** Never import application source, follow symlinks, or inspect generated environment files. */
export function inventoryBackupWriters(repositoryRoot: string): {
  scope: 'typescript-source-candidates-only';
  completeWriterCoverage: false;
  inspectedFiles: number;
  candidates: BackupWriterCandidate[];
} {
  const candidates: BackupWriterCandidate[] = [];
  let inspectedFiles = 0;
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (
        entry.name.startsWith('.') ||
        ['node_modules', 'dist', '__tests__', 'test', 'fixtures'].includes(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !/\.(test|spec|d)\.ts$/.test(entry.name)
      ) {
        inspectedFiles++;
        candidates.push(
          ...inspectBackupWriterCandidates(
            readFileSync(path, 'utf8'),
            relative(repositoryRoot, path)
          )
        );
      }
    }
  }
  for (const entry of readdirSync(join(repositoryRoot, 'packages'), {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(repositoryRoot, 'packages', entry.name);
    if (
      readdirSync(directory, { withFileTypes: true }).some(
        (child) => child.name === 'src' && child.isDirectory()
      )
    ) {
      walk(join(directory, 'src'));
    }
  }
  return {
    scope: 'typescript-source-candidates-only',
    completeWriterCoverage: false,
    inspectedFiles,
    candidates,
  };
}
