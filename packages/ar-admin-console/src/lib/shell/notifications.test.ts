import { describe, expect, it } from 'vitest';
import {
	SEVERITIES,
	countNotifications,
	isDismissible,
	notificationHref,
	orderNotifications,
	type ShellNotification
} from './notifications';

const item = (id: string, severity: ShellNotification['severity']): ShellNotification => ({
	id,
	severity,
	text: id
});

describe('notification counts', () => {
	it('counts each severity and has a zero for the ones without items', () => {
		const counts = countNotifications([
			item('a', 'critical'),
			item('b', 'info'),
			item('c', 'info'),
			item('d', 'high')
		]);
		expect(counts).toEqual({ critical: 1, high: 1, caution: 0, info: 2 });
		expect(countNotifications([])).toEqual({ critical: 0, high: 0, caution: 0, info: 0 });
	});

	it('has one count for every severity the header draws', () => {
		expect(Object.keys(countNotifications([])).sort()).toEqual([...SEVERITIES].sort());
	});
});

describe('notification order', () => {
	it('puts the most urgent first and keeps the given order inside a severity', () => {
		const ordered = orderNotifications([
			item('info-new', 'info'),
			item('caution', 'caution'),
			item('crit-old', 'critical'),
			item('high-new', 'high'),
			item('high-old', 'high')
		]);
		expect(ordered.map((n) => n.id)).toEqual([
			'crit-old',
			'high-new',
			'high-old',
			'caution',
			'info-new'
		]);
	});

	it('does not change the list it was given', () => {
		const given = [item('a', 'info'), item('b', 'critical')];
		orderNotifications(given);
		expect(given.map((n) => n.id)).toEqual(['a', 'b']);
	});
});

describe('notification links and dismissal', () => {
	it('links to the notification page of the operations category', () => {
		expect(notificationHref('n1')).toBe('/admin/integrations/notifications?id=n1');
		expect(notificationHref('a b/c')).toBe('/admin/integrations/notifications?id=a%20b%2Fc');
	});

	it('lets only information be dismissed on the spot', () => {
		expect(SEVERITIES.filter((severity) => isDismissible(item('x', severity)))).toEqual(['info']);
	});
});
