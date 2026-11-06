import { describe, expect, it } from 'vitest';
import type { AdminAuditEntry } from '#lib/api/admin-audit.js';
import { hasMessage } from '#lib/i18n/i18n.svelte.js';
import { actionLabelKey, actorKindKey, actorName, isStepUp, stepUpFacts } from './audit-labels';

const base: AdminAuditEntry = {
	id: 'a',
	action: 'settings.update',
	result: 'success',
	created_at: 0
};
const t = (key: string) => key;

describe('audit labels', () => {
	it('names a step-up receipt with the operation and level it checked', () => {
		const entry = {
			...base,
			action: 'admin.step_up.receipt_issued',
			metadata: { operation: 'admin.role.grant', level: 'L2' }
		};
		expect(isStepUp(entry.action)).toBe(true);
		expect(stepUpFacts(entry)).toEqual({ operation: 'admin.role.grant', level: 'L2' });
		expect(actionLabelKey(entry.action, hasMessage)).toBe(
			'aud.action.admin.step_up.receipt_issued'
		);
	});

	it('ignores step-up metadata it cannot read, and entries that are not step-ups', () => {
		expect(
			stepUpFacts({ ...base, action: 'admin.step_up.receipt_issued', metadata: { level: 'L3' } })
		).toBeNull();
		expect(stepUpFacts({ ...base, metadata: { operation: 'x', level: 'L1' } })).toBeNull();
		expect(actionLabelKey('settings.update', hasMessage)).toBeNull();
	});

	it('names who did it, falling back from the name to the id', () => {
		expect(actorName({ ...base, admin_email: 'a@example.com' }, t)).toBe('a@example.com');
		expect(actorName({ ...base, actor_id: 'amp_1' }, t)).toBe('amp_1');
		expect(actorName(base, t)).toBe('aud.actor.unknown');
		expect(actorKindKey({ ...base, actor_type: 'machine' })).toBe('aud.actor.machine');
		expect(actorKindKey({ ...base, actor_type: 'admin_user' })).toBeNull();
	});
});
