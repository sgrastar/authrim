/** Trusted registry metadata only; never accept ownership rules from a backup bundle. */
export type BackupRowOwnership =
  | { kind: 'tenant'; column: string; identity: 'tenantId' | 'tenantKey' }
  | { kind: 'scope'; typeColumn: string; idColumn: string }
  | {
      kind: 'parent';
      table: string;
      keys: readonly { child: string; parent: string }[];
      ownership: BackupRowOwnership;
    };

export interface BackupTenantIdentity {
  tenantId: string;
  /** Resolve from the authoritative tenant record, not a caller-supplied substitute. */
  tenantKey: string;
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('backup_ownership_invalid_identifier');
  return `"${value}"`;
}

/**
 * Build a parameterized predicate for a reviewed dataset's ownership relation.
 * Does not authorize the caller or resolve inherited platform settings. Parent rows
 * must be read at the same snapshot boundary as children when used during capture.
 */
export function backupOwnershipPredicate(
  ownership: BackupRowOwnership,
  identity: BackupTenantIdentity,
  rowAlias = 'backup_row'
): { sql: string; params: string[] } {
  if (!identity.tenantId || !identity.tenantKey)
    throw new Error('backup_ownership_missing_identity');
  const params: string[] = [];
  function compile(rule: BackupRowOwnership, alias: string, depth: number): string {
    if (depth > 16) throw new Error('backup_ownership_depth_exceeded');
    const row = identifier(alias);
    switch (rule.kind) {
      case 'tenant': {
        if (rule.identity !== 'tenantId' && rule.identity !== 'tenantKey') {
          throw new Error('backup_ownership_invalid_identity');
        }
        params.push(identity[rule.identity]);
        return `${row}.${identifier(rule.column)} = ?`;
      }
      case 'scope':
        params.push('tenant', identity.tenantId);
        return `(${row}.${identifier(rule.typeColumn)} = ? AND ${row}.${identifier(rule.idColumn)} = ?)`;
      case 'parent': {
        if (
          rule.keys.length === 0 ||
          new Set(rule.keys.map((key) => key.child)).size !== rule.keys.length ||
          new Set(rule.keys.map((key) => key.parent)).size !== rule.keys.length
        ) {
          throw new Error('backup_ownership_invalid_parent_keys');
        }
        const parentAlias = `backup_parent_${depth}`;
        if (parentAlias === rowAlias) throw new Error('backup_ownership_alias_collision');
        const parent = identifier(parentAlias);
        const joins = rule.keys.map(
          (key) => `${parent}.${identifier(key.parent)} = ${row}.${identifier(key.child)}`
        );
        return `EXISTS (SELECT 1 FROM ${identifier(rule.table)} AS ${parent} WHERE ${joins.join(' AND ')} AND ${compile(rule.ownership, parentAlias, depth + 1)})`;
      }
      default:
        throw new Error('backup_ownership_unknown_rule');
    }
  }
  return { sql: compile(ownership, rowAlias, 0), params };
}
