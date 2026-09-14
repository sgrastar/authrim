-- Preserve the source row partition at the snapshot boundary. This lets one physical table
-- contribute independently selectable logical datasets without reading the current row state.
ALTER TABLE tenant_backup_preimages ADD COLUMN row_partition TEXT
  CHECK (
    row_partition IS NULL OR (
      typeof(row_partition) = 'text'
      AND length(row_partition) BETWEEN 1 AND 64
    )
  );
