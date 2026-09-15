-- One small boundary lookup per dataset, independent of the number of encrypted chunks.
CREATE INDEX idx_tenant_backup_input_dataset_boundary
ON tenant_backup_input_receipts(operation_id,bundle_id,json_extract(checkpoint_json,'$.content.datasetIndex'),sequence)
WHERE json_extract(checkpoint_json,'$.content.phase')='datasets'
  AND json_extract(checkpoint_json,'$.content.chunks')=0;
