import { describe, expect, it } from 'vitest';
import { consentStatementListItemFromRow } from './consent-statements';

describe('consentStatementListItemFromRow', () => {
	it('reads the summary the list endpoint adds to each statement', () => {
		const item = consentStatementListItemFromRow({
			id: 'st-1',
			slug: 'tos',
			category: 'terms_of_service',
			is_active: 1,
			current_version: { id: 'v-1', version: '20260201', status: 'active', is_current: 1 },
			has_draft: true,
			titles: { ja: '利用規約', en: 'Terms', de: 3 }
		});
		expect(item.statement.slug).toBe('tos');
		expect(item.current?.id).toBe('v-1');
		expect(item.current?.is_current).toBe(true);
		expect(item.hasDraft).toBe(true);
		expect(item.titles).toEqual({ ja: '利用規約', en: 'Terms' });
	});

	it('treats a statement without a summary as having no version', () => {
		const item = consentStatementListItemFromRow({ id: 'st-2', slug: 'news' });
		expect(item).toMatchObject({ current: null, hasDraft: false, titles: {} });
	});
});
