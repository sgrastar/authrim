import { describe, expect, it } from 'vitest';
import { hasMessage } from '#lib/i18n/i18n.svelte.js';
import {
	COMMON_USER_AUDIT_EVENTS,
	eventLabel,
	eventLabelKey,
	eventOptions,
	metadataJson,
	resultOf
} from './user-audit-labels';

const t = (key: string) => key;

describe('user audit labels', () => {
	it('has a console name for every common event', () => {
		expect(COMMON_USER_AUDIT_EVENTS.length).toBeGreaterThanOrEqual(40);
		expect(new Set(COMMON_USER_AUDIT_EVENTS).size).toBe(COMMON_USER_AUDIT_EVENTS.length);
		for (const code of COMMON_USER_AUDIT_EVENTS) {
			expect(eventLabelKey(code, hasMessage), code).toBe(`uaud.ev.${code}`);
		}
	});

	it('falls back to the event code, and never to nothing', () => {
		expect(eventLabel('custom.thing.happened', t, hasMessage)).toBe('custom.thing.happened');
		expect(eventLabel('', t, hasMessage)).toBe('uaud.event.unknown');
		expect(eventLabel('user.suspend', t, hasMessage)).toBe('uaud.ev.user.suspend');
	});

	it('lists all events first, then the common ones, and keeps an event outside them selectable', () => {
		const options = eventOptions(t, hasMessage);
		expect(options[0]).toEqual({ value: '', label: 'uaud.filter.event.all' });
		expect(options).toHaveLength(COMMON_USER_AUDIT_EVENTS.length + 1);
		expect(options[1].value).toBe('auth.login.succeeded');
		const extra = eventOptions(t, hasMessage, 'x.y.z');
		expect(extra.at(-1)).toEqual({ value: 'x.y.z', label: 'x.y.z' });
	});

	it('shows a result only when the event has one the console knows', () => {
		expect(resultOf({ result: 'failure' })).toBe('failure');
		expect(resultOf({ result: null })).toBeNull();
		expect(resultOf({})).toBeNull();
		expect(resultOf({ result: 'partial' as never })).toBeNull();
	});

	it('shows metadata only when there is some', () => {
		expect(metadataJson({})).toBeNull();
		expect(metadataJson(null)).toBeNull();
		expect(metadataJson({ a: 1 })).toBe('{\n  "a": 1\n}');
	});
});
