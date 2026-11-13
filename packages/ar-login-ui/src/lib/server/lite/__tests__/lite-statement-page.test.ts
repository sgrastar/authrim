import { describe, expect, it, vi } from 'vitest';
import { liteMessages } from '#lib/server/lite/messages.js';
import { liteStatementPage } from '#lib/server/lite/statement-page.js';

const BODY = {
	slug: 'terms',
	category: 'terms_of_service',
	language: 'en',
	title: 'Terms',
	description: '',
	content_type: 'inline',
	document_url: null,
	inline_content: '<p>One <script>x</script></p>',
	version: { version: '20260101', effective_at: 1, is_current: false },
	versions: [
		{ version: '20261113', effective_at: 2, is_current: true },
		{ version: '20260101', effective_at: 1, is_current: false }
	]
};

function backend(status: number, json: unknown) {
	const request = vi.fn(async (_path: string) => ({ status, json }));
	return { client: request, request };
}

describe('the lite statement page', () => {
	it('reads the version asked in the page language, sanitized, with the other versions', async () => {
		const { LL } = await liteMessages('en');
		const { client, request } = backend(200, BODY);
		const page = await liteStatementPage(client, 'terms', '20260101', 'en', LL);
		expect(request).toHaveBeenCalledWith(
			'/api/v1/consent-statements/terms?version=20260101&lang=en'
		);
		expect(page).toMatchObject({
			kind: 'statement',
			title: 'Terms',
			isCurrent: false,
			older: { href: '/statements/terms?lang=en' },
			versions: {
				items: [
					{ href: '/statements/terms?lang=en', current: true },
					{ href: null, current: false }
				]
			}
		});
		if (page.kind !== 'statement') throw new Error('expected a statement');
		expect(page.html).not.toContain('<script>');
	});

	it('is not found for an unknown statement or a malformed slug, and unavailable otherwise', async () => {
		const { LL } = await liteMessages('en');
		expect(await liteStatementPage(backend(404, null).client, 'x', null, 'en', LL)).toMatchObject({
			kind: 'missing',
			message: null
		});
		const malformed = backend(200, BODY);
		for (const slug of ['a/b', '..', '.', 'a%2F..']) {
			expect(await liteStatementPage(malformed.client, slug, null, 'en', LL), slug).toMatchObject({
				kind: 'missing'
			});
		}
		expect(malformed.request).not.toHaveBeenCalled();
		expect(await liteStatementPage(backend(500, null).client, 'x', null, 'en', LL)).toMatchObject({
			kind: 'missing',
			message: LL.statement_pageUnavailable()
		});
		expect(await liteStatementPage(async () => null, 'x', null, 'en', LL)).toMatchObject({
			kind: 'missing',
			message: LL.statement_pageUnavailable()
		});
	});
});

describe('a statement kept in Authrim on the lite consent step', () => {
	it('is framed from its statement page, version included', async () => {
		const { readLiteFlowConsent } = await import('#lib/server/lite/flow-consent.js');
		const consent = readLiteFlowConsent({
			id: 'consent',
			content: {
				consent_policy: {
					language: 'ja',
					items: [
						{
							statement_id: 'tos',
							slug: 'terms',
							title: 'Terms',
							description: '',
							document_url: null,
							inline_content: '<p>Text</p>',
							version: '20261113',
							is_required: true,
							content_mode: 'checkbox',
							checkbox_mode: 'required'
						}
					]
				}
			}
		} as never);
		if (!consent || consent === 'unsupported') throw new Error('expected a consent');
		expect(consent.items[0]).toMatchObject({
			display: 'embedded',
			frame: '/statements/terms/embed?version=20261113&lang=ja',
			link: '/statements/terms?version=20261113&lang=ja',
			kind: 'checkbox'
		});
	});
});
