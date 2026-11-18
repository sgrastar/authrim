import { describe, expect, it } from 'vitest';
import { createFakeSamlSettings } from '#lib/api/fake/saml-settings-fake.js';
import type { SamlSettings } from '#lib/api/saml-settings.js';
import { answerSamlSettingsMock } from './dev-saml-settings-mock.js';

describe('the dev mock for the SAML identity', () => {
	it('answers the settings, a rollover and the certificate preview', async () => {
		const client = createFakeSamlSettings();
		const read = await answerSamlSettingsMock(client, ['saml-settings'], 'GET', undefined);
		expect(read?.status).toBe(200);
		const settings = read!.body as SamlSettings;
		expect(settings.tenantId).toBe('acme');

		const published = await answerSamlSettingsMock(
			client,
			['saml-settings', 'local-signing'],
			'POST',
			{ role: 'sp', action: 'publish_next' }
		);
		expect((published!.body as SamlSettings).localSigning?.spSigningKeyPolicy.next).toBeDefined();

		const pem = settings.localSigning!.idpSigningKeyPolicy.active!.certificate!;
		const preview = await answerSamlSettingsMock(
			client,
			['saml-metadata', 'certificate-preview'],
			'POST',
			{ certificate: pem }
		);
		expect(preview?.status).toBe(200);
		expect((preview!.body as { subject: string }).subject).toContain('CN=');
	});

	it('returns the fake’s refusals in the wire shape and ignores other paths', async () => {
		const client = createFakeSamlSettings();
		const short = await answerSamlSettingsMock(
			client,
			['saml-settings', 'local-signing', 'dr-bundle'],
			'POST',
			{ passphrase: 'short' }
		);
		expect(short).toMatchObject({ status: 400, body: { error: 'validation_failed' } });
		expect(await answerSamlSettingsMock(client, ['saml-providers'], 'GET', undefined)).toBeNull();
		expect(
			await answerSamlSettingsMock(client, ['saml-settings', 'nope'], 'GET', undefined)
		).toBeNull();
	});
});
