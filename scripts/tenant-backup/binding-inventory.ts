import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export type BackupBindingKind = 'KVNamespace' | 'R2Bucket' | 'DurableObjectNamespace';
export interface BackupBindingDeclaration {
  name: string;
  kind: BackupBindingKind;
  source: string;
  line: number;
}
const kinds = new Set<string>(['KVNamespace', 'R2Bucket', 'DurableObjectNamespace']);

/** Declaration inventory only: a binding may contain multiple canonical and transient key classes. */
export function inspectBackupBindings(source: string, path: string): BackupBindingDeclaration[] {
  // Most source files contain no storage type references. Parse only candidates;
  // the AST (not this prefilter) still determines whether a declaration exists.
  if (![...kinds].some((kind) => source.includes(kind))) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const bindings: BackupBindingDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertySignature(node) && node.type) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        const inspectType = (type: ts.Node) => {
          if (ts.isTypeReferenceNode(type) && kinds.has(type.typeName.getText(file))) {
            bindings.push({
              name,
              kind: type.typeName.getText(file) as BackupBindingKind,
              source: path,
              line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            });
          }
          ts.forEachChild(type, inspectType);
        };
        inspectType(node.type);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
}

/** Read source declarations without importing Workers or inspecting generated secret/config files. */
export function inventoryBackupBindings(repositoryRoot: string): BackupBindingDeclaration[] {
  const result: BackupBindingDeclaration[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (['node_modules', 'dist', '__tests__', 'test', '.svelte-kit'].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !/\.(test|spec)\.ts$/.test(entry.name)
      ) {
        result.push(
          ...inspectBackupBindings(readFileSync(path, 'utf8'), relative(repositoryRoot, path))
        );
      }
    }
  };
  const packages = join(repositoryRoot, 'packages');
  for (const entry of readdirSync(packages, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(packages, entry.name);
    if (
      readdirSync(packagePath, { withFileTypes: true }).some(
        (child) => child.isDirectory() && child.name === 'src'
      )
    ) {
      walk(join(packagePath, 'src'));
    }
  }
  return result;
}
