export class UserInfoSubjectMismatchError extends Error {
  constructor() {
    super('Userinfo sub claim mismatch');
    this.name = 'UserInfoSubjectMismatchError';
  }
}

export function assertUserInfoSubjectMatches(
  idTokenSub: string | undefined,
  userInfoSub: string | undefined
): void {
  if (idTokenSub && userInfoSub && userInfoSub !== idTokenSub) {
    throw new UserInfoSubjectMismatchError();
  }
}
