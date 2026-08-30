export const ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE =
  'account_directory_write_binding_unavailable';
export const LOOKUP_REGISTRY_GENERATION_PROPAGATING = 'lookup_registry_generation_mismatch';

export function isAccountDirectoryWriteBindingUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE;
}

export function isLookupRegistryGenerationPropagating(error: unknown): boolean {
  return error instanceof Error && error.message === LOOKUP_REGISTRY_GENERATION_PROPAGATING;
}
