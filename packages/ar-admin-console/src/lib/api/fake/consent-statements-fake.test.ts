import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError } from '../api-error';
import { MOCK_CONSENT_STATEMENTS, createFakeConsentStatements } from './consent-statements-fake';

const make = () => createFakeConsentStatements(structuredClone(MOCK_CONSENT_STATEMENTS));
const input = { title: 'T', description: 'D', inline_content: 'x' };

describe('fake consent statements', () => {
	it('names a statement by its current version, or its draft', async () => {
		const items = await make().list();
		const terms = items.find((item) => item.statement.slug === 'terms-of-service')!;
		expect(terms.current?.version).toBe('20260401');
		expect(terms.hasDraft).toBe(true);
		expect(terms.titles.en).toBe('Terms of service');
		const marketing = items.find((item) => item.statement.slug === 'marketing-mail')!;
		expect(marketing.current).toBeNull();
		expect(marketing.titles.en).toBe('Marketing mail');
	});

	it('refuses a key that is taken', async () => {
		await expect(make().create({ slug: 'terms-of-service' })).rejects.toBeInstanceOf(ConflictError);
	});

	it('checks a version number and its uniqueness', async () => {
		const client = make();
		await expect(
			client.createVersion('stmt_terms', { version: '20261301', effective_at: 1 })
		).rejects.toMatchObject({ status: 400 });
		await expect(
			client.createVersion('stmt_terms', { version: '20260401', effective_at: 1 })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('changes texts of a draft only', async () => {
		const client = make();
		await client.saveLocalization('stmt_terms', 'ver_terms_3', 'de', input);
		await expect(
			client.saveLocalization('stmt_terms', 'ver_terms_2', 'de', input)
		).rejects.toMatchObject({ status: 409 });
		await expect(client.removeVersion('stmt_terms', 'ver_terms_2')).rejects.toMatchObject({
			status: 400
		});
	});

	it('publishes: the draft becomes current and the old one is archived', async () => {
		const client = make();
		await client.activateVersion('stmt_terms', 'ver_terms_3', { reconsent: true });
		const detail = await client.get('stmt_terms');
		expect(detail.versions.find((v) => v.id === 'ver_terms_3')?.status).toBe('active');
		expect(detail.versions.find((v) => v.id === 'ver_terms_2')?.status).toBe('archived');
		expect(detail.statement.required_consent_version).toBe('20261101');
	});

	it('refuses an older version without asking again, and an empty one', async () => {
		const client = make();
		const old = await client.createVersion('stmt_terms', {
			version: '20250101',
			effective_at: 1
		});
		await expect(client.activateVersion('stmt_terms', old.id)).rejects.toMatchObject({
			status: 400
		});
		await client.saveLocalization('stmt_terms', old.id, 'ja', input);
		await expect(
			client.activateVersion('stmt_terms', old.id, { reconsent: false })
		).rejects.toMatchObject({ status: 400, message: expect.stringContaining('older than') });
	});

	it('retires a published statement and cannot turn it back on', async () => {
		const client = make();
		expect(await client.remove('stmt_terms')).toBe('retired');
		await expect(client.update('stmt_terms', { is_active: true })).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('answers where statements are used, or fails like an API without it', async () => {
		const used = await make().usages();
		expect(used.byStatement.stmt_terms.services).toHaveLength(2);
		await expect(createFakeConsentStatements({ usagesFail: true }).usages()).rejects.toBeInstanceOf(
			ApiError
		);
	});
});
