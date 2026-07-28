import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const signupSource = readFileSync(resolve(__dirname, '../routes/signup/+page.svelte'), 'utf8');

describe('signup validation localization', () => {
	it('uses the shared translation for configured and runtime required fields', () => {
		expect(signupSource.match(/\$LL\.common_requiredField/g)).toHaveLength(2);
		expect(signupSource).not.toMatch(/\$\{[^}]+\} is required/);
	});
});
