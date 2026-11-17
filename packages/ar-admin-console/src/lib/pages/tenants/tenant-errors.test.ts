import { describe, expect, it } from 'vitest';
import { errorFromResponse } from '#lib/api/api-error.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { domainErrorText, tenantErrorKey } from './tenant-errors';

const response = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('refusals, as they arrive from the API', () => {
	it('tells a lite-mode refusal apart from other conflicts (409 comes as a ConflictError)', async () => {
		const lite = await errorFromResponse(response({ error: 'lite_mode_unsupported' }, 409));
		expect(domainErrorText(lite)).toBe(t('tn.dom.error.lite'));
		const changing = await errorFromResponse(
			response({ error: 'lite_mode_change_in_progress' }, 409)
		);
		expect(domainErrorText(changing)).toBe(t('tn.dom.error.liteChanging'));
		const other = await errorFromResponse(response({ error: 'tenant_state_changed' }, 409));
		expect(domainErrorText(other)).toBe(t('tn.error.conflict'));
	});

	it('keeps the API’s reason for a refused value', async () => {
		const refused = await errorFromResponse(
			response(
				{ error: 'invalid_request', error_description: 'An active vanity domain already exists' },
				400
			)
		);
		expect(domainErrorText(refused)).toContain('An active vanity domain already exists');
	});

	it('names the protected default tenant', async () => {
		const protectedTenant = await errorFromResponse(
			response({ error: 'default_tenant_protected' }, 409)
		);
		expect(tenantErrorKey(protectedTenant)).toBe('tn.error.defaultProtected');
	});
});
