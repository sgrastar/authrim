export type CredentialRotationStatus =
  | 'none'
  | 'testing'
  | 'ready'
  | 'active'
  | 'retiring'
  | 'failed';

export interface CredentialRotationState {
  credentialRef: string | null;
  credentialVersion: number;
  nextCredentialRef: string | null;
  nextCredentialVersion: number | null;
  previousCredentialRef: string | null;
  previousCredentialRetireAfter: number | null;
  rotationStatus: CredentialRotationStatus;
}

export interface CredentialRotationActivationResult {
  state: CredentialRotationState;
  previousCredentialRefToRetire: string | null;
}

export function prepareCredentialRotation(
  current: CredentialRotationState,
  next: { credentialRef: string; credentialVersion: number }
): CredentialRotationState {
  return {
    ...current,
    nextCredentialRef: next.credentialRef,
    nextCredentialVersion: next.credentialVersion,
    rotationStatus: 'testing',
  };
}

export function markCredentialRotationReady(
  current: CredentialRotationState
): CredentialRotationState {
  if (!current.nextCredentialRef || current.nextCredentialVersion === null) {
    return {
      ...current,
      rotationStatus: 'failed',
    };
  }
  return {
    ...current,
    rotationStatus: 'ready',
  };
}

export function activateCredentialRotation(
  current: CredentialRotationState,
  options: { now: number; overlapMs: number }
): CredentialRotationActivationResult {
  if (!current.nextCredentialRef || current.nextCredentialVersion === null) {
    return {
      state: {
        ...current,
        rotationStatus: 'failed',
      },
      previousCredentialRefToRetire: null,
    };
  }

  return {
    state: {
      credentialRef: current.nextCredentialRef,
      credentialVersion: current.nextCredentialVersion,
      nextCredentialRef: null,
      nextCredentialVersion: null,
      previousCredentialRef: current.credentialRef,
      previousCredentialRetireAfter: current.credentialRef ? options.now + options.overlapMs : null,
      rotationStatus: current.credentialRef ? 'retiring' : 'active',
    },
    previousCredentialRefToRetire: current.credentialRef,
  };
}

export function finishCredentialRetirement(
  current: CredentialRotationState,
  now: number
): CredentialRotationState {
  if (
    current.previousCredentialRef &&
    current.previousCredentialRetireAfter !== null &&
    current.previousCredentialRetireAfter <= now
  ) {
    return {
      ...current,
      previousCredentialRef: null,
      previousCredentialRetireAfter: null,
      rotationStatus: 'none',
    };
  }
  return current;
}
