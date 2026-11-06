import { describe, expect, it, vi } from 'vitest';
import { startTotpReauth, verifyTotpReauth } from './reauth-totp';

describe('standard re-authentication TOTP binding', () => {
	it('uses the challenge subject and binds verification to the OAuth challenge', async () => {
		const api = {
			startLogin: vi.fn().mockResolvedValue({ data: { challenge_id: 'totp_challenge' } }),
			verifyLogin: vi.fn().mockResolvedValue({ data: { success: true } })
		};

		await startTotpReauth(api, 'oauth_challenge');
		await verifyTotpReauth(api, {
			totpChallengeId: 'totp_challenge',
			code: '123456',
			authorizationChallengeId: 'oauth_challenge'
		});

		expect(api.startLogin).toHaveBeenCalledWith({
			authorizationChallengeId: 'oauth_challenge'
		});
		expect(api.verifyLogin).toHaveBeenCalledWith({
			challengeId: 'totp_challenge',
			code: '123456',
			authorizationChallengeId: 'oauth_challenge'
		});
	});
});
