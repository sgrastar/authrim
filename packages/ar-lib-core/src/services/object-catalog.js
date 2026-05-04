export const OBJECT_CLASSES = [
    'admin_audit_detail',
    'webhook_delivery_payload',
    'operational_log_detail',
    'user_export',
    'user_import_input',
    'user_import_result',
    'approval_transport_detail',
];
export const OBJECT_REPRESENTATIONS = [
    'canonical_json',
    'csv_projection',
    'ndjson_projection',
    'zip_bundle',
];
export const OBJECT_KINDS = ['single', 'manifest', 'chunk'];
export function generatePublicArtifactId() {
    return `oa_${crypto.randomUUID().replace(/-/g, '')}`;
}
export function isObjectClass(value) {
    return OBJECT_CLASSES.includes(value);
}
export function isObjectRepresentation(value) {
    return OBJECT_REPRESENTATIONS.includes(value);
}
export function isObjectKind(value) {
    return OBJECT_KINDS.includes(value);
}
