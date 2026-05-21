import { describe, expect, it } from 'vitest';

import {
  activateCredentialRotation,
  finishCredentialRetirement,
  markCredentialRotationReady,
  prepareCredentialRotation,
  type CredentialRotationState,
} from '../index';

const activeState: CredentialRotationState = {
  credentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v1.json#v1',
  credentialVersion: 1,
  nextCredentialRef: null,
  nextCredentialVersion: null,
  previousCredentialRef: null,
  previousCredentialRetireAfter: null,
  rotationStatus: 'none',
};

describe('credential rotation state helpers', () => {
  it('prepares and marks a next credential as ready', () => {
    const prepared = prepareCredentialRotation(activeState, {
      credentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2',
      credentialVersion: 2,
    });

    expect(prepared).toMatchObject({
      credentialRef: activeState.credentialRef,
      credentialVersion: 1,
      nextCredentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2',
      nextCredentialVersion: 2,
      rotationStatus: 'testing',
    });
    expect(markCredentialRotationReady(prepared)).toMatchObject({
      rotationStatus: 'ready',
    });
  });

  it('activates a ready credential and keeps the previous credential through overlap', () => {
    const prepared = markCredentialRotationReady(
      prepareCredentialRotation(activeState, {
        credentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2',
        credentialVersion: 2,
      })
    );

    const result = activateCredentialRotation(prepared, {
      now: 1779148800000,
      overlapMs: 30 * 60 * 1000,
    });

    expect(result.previousCredentialRefToRetire).toBe(activeState.credentialRef);
    expect(result.state).toEqual({
      credentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2',
      credentialVersion: 2,
      nextCredentialRef: null,
      nextCredentialVersion: null,
      previousCredentialRef: activeState.credentialRef,
      previousCredentialRetireAfter: 1779150600000,
      rotationStatus: 'retiring',
    });
  });

  it('clears previous credential after the overlap window', () => {
    const state = {
      ...activeState,
      credentialRef: 'next',
      credentialVersion: 2,
      previousCredentialRef: 'previous',
      previousCredentialRetireAfter: 1779150600000,
      rotationStatus: 'retiring' as const,
    };

    expect(finishCredentialRetirement(state, 1779150599999)).toEqual(state);
    expect(finishCredentialRetirement(state, 1779150600000)).toEqual({
      ...state,
      previousCredentialRef: null,
      previousCredentialRetireAfter: null,
      rotationStatus: 'none',
    });
  });

  it('marks activation as failed when no next credential exists', () => {
    expect(
      activateCredentialRotation(activeState, {
        now: 1779148800000,
        overlapMs: 1,
      }).state
    ).toMatchObject({
      rotationStatus: 'failed',
    });
  });
});
