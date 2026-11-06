export function startTotpReauth<TResult>(
	api: { startLogin(data: { authorizationChallengeId: string }): Promise<TResult> },
	authorizationChallengeId: string
) {
	return api.startLogin({ authorizationChallengeId });
}

export function verifyTotpReauth<TResult>(
	api: {
		verifyLogin(data: {
			challengeId: string;
			code: string;
			authorizationChallengeId: string;
		}): Promise<TResult>;
	},
	input: {
		totpChallengeId: string;
		code: string;
		authorizationChallengeId: string;
	}
) {
	return api.verifyLogin({
		challengeId: input.totpChallengeId,
		code: input.code,
		authorizationChallengeId: input.authorizationChallengeId
	});
}
