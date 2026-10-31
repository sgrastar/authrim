import { describe, expect, it } from 'vitest';
import { reauthProofFromRecord } from '../direct-auth';

describe('reauthProofFromRecord', () => {
  it('takes a recorded pair as proven, even for a method the session first left unverified', () => {
    // A passkey registered without attestation, then signed on the account page.
    expect(
      reauthProofFromRecord(
        { reauth_proven_amr: ['passkey'], reauth_proven_at: 2_000 },
        ['pwd', 'directory', 'passkey'],
        ['passkey']
      )
    ).toEqual({ method: 'passkey', provenAtMs: 2_000 });
  });

  it('still leaves an unverified method out of the session amr', () => {
    expect(
      reauthProofFromRecord({ proven_at: 1_000 }, ['pwd', 'directory', 'passkey'], ['passkey'])
    ).toEqual({ method: 'directory_password', provenAtMs: 1_000 });
  });
});
