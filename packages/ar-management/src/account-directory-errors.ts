export const ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE =
  'account_directory_write_binding_unavailable';

export function isAccountDirectoryWriteBindingUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === ACCOUNT_DIRECTORY_WRITE_BINDING_UNAVAILABLE;
}
