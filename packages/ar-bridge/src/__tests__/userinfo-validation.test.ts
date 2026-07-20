import { describe, expect, it } from 'vitest';
import {
  UserInfoSubjectMismatchError,
  assertUserInfoSubjectMatches,
} from '../utils/userinfo-validation';

describe('assertUserInfoSubjectMatches', () => {
  it('accepts matching subjects', () => {
    expect(() => assertUserInfoSubjectMatches('subject-1', 'subject-1')).not.toThrow();
  });

  it('rejects a UserInfo subject that differs from the ID Token subject', () => {
    expect(() => assertUserInfoSubjectMatches('subject-1', 'attacker-subject')).toThrow(
      UserInfoSubjectMismatchError
    );
  });

  it('does not invent a mismatch when either response omits a subject', () => {
    expect(() => assertUserInfoSubjectMatches(undefined, 'subject-1')).not.toThrow();
    expect(() => assertUserInfoSubjectMatches('subject-1', undefined)).not.toThrow();
  });
});
