/**
 * Fields for a scheduler warning. `errorCode` is the error's message only when it is a fixed
 * snake_case code (as the services throw them), so the warning names the failed step without
 * carrying free text, identifiers or other data an error message could contain.
 */
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{2,127}$/;

export function schedulerErrorMeta(error: unknown): { errorType: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorType: 'Unknown' };
  return SAFE_ERROR_CODE.test(error.message)
    ? { errorType: error.name, errorCode: error.message }
    : { errorType: error.name };
}
