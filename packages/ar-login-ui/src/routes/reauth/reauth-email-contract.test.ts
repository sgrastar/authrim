import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '+page.svelte'), 'utf8');
const view = readFileSync(resolve(__dirname, '../../lib/views/ReauthView.svelte'), 'utf8');

describe('re-authentication by email code starts from a typed address', () => {
	it('asks for the address when the challenge does not name it, and binds it to the page', () => {
		expect(view).toContain('{#if !challengeData?.user?.email}');
		expect(view).toContain('bind:value={email}');
		expect(page).toContain('bind:email');
	});

	it('sends the code to the validated address, against the same authorization challenge', () => {
		expect(page).toContain('readReauthEmail(email)');
		expect(page).toMatch(/emailCodeAPI\.send\(\{\s*email: address,/);
		expect(page).toContain('authorizationChallengeId: challengeId || undefined');
		expect(page).toContain('verify-email-code?email=${encodeURIComponent(address)}');
	});
});
