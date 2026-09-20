export interface BackupSchemaColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultSql: string | null;
  primaryKeyPosition: number;
  generated: boolean;
}

export interface BackupSchemaForeignKey {
  id: number;
  position: number;
  parentTable: string;
  column: string;
  parentColumn: string | null;
  onUpdate: string;
  onDelete: string;
}

export interface BackupSchemaIndex {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  sql: string | null;
  columns: Array<{
    position: number;
    name: string | null;
    collation: string;
    descending: boolean;
    key: boolean;
  }>;
}

export interface BackupSchemaTable {
  name: string;
  sql: string;
  columns: BackupSchemaColumn[];
  foreignKeys: BackupSchemaForeignKey[];
  indexes: BackupSchemaIndex[];
  triggers?: Array<{ name: string; sql: string }>;
  withoutRowid: boolean;
  strict: boolean;
}
