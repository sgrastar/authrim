import { describe, expect, it } from 'vitest';
import { auditListParams, auditPageFrom } from './admin-audit';

describe('admin audit client', () => {
	it('sends the filters, and instants rather than days', () => {
		const params = auditListParams({
			actor: 'adm_1',
			action: 'admin.role.grant',
			result: 'failure',
			from: new Date('2026-11-07T09:00:00Z'),
			to: new Date('2026-11-07T10:30:00Z')
		});
		expect(Object.fromEntries(params)).toEqual({
			limit: '50',
			page: '1',
			admin_user_id: 'adm_1',
			action: 'admin.role.grant',
			result: 'failure',
			start_date: '2026-11-07T09:00:00.000Z',
			end_date: '2026-11-07T10:30:00.000Z'
		});
		expect(auditListParams({ at: { cursor: 'c1' } }).get('cursor')).toBe('c1');
		expect(auditListParams({ at: { cursor: 'c1' } }).has('page')).toBe(false);
	});

	it('reads both page shapes as one', () => {
		expect(auditPageFrom({ items: [], total: 120, page: 1, totalPages: 3 })).toEqual({
			items: [],
			total: 120,
			next: { page: 2 },
			mayLag: false
		});
		expect(auditPageFrom({ items: [], total: 3, page: 1, totalPages: 1 }).next).toBeNull();
		expect(
			auditPageFrom({
				items: [],
				pagination: { has_more: true, next_cursor: 'c2' },
				coverage: { consistency: 'eventual', pending_deliveries: 0 }
			})
		).toEqual({ items: [], total: null, next: { cursor: 'c2' }, mayLag: true });
		expect(
			auditPageFrom({ items: [], pagination: { has_more: false, next_cursor: null } }).next
		).toBeNull();
	});
});
