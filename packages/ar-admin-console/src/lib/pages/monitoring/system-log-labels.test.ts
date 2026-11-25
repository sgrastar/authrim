import { describe, expect, it } from 'vitest';
import type { MessageKey } from '#lib/i18n/messages/ja.js';
import { ja } from '#lib/i18n/messages/ja.js';
import {
	SYSTEM_LOG_SOURCES,
	eventLabel,
	eventLabelKey,
	resultOf,
	severityOf,
	sourceLabel,
	sourceOptions,
	surfaceOf
} from './system-log-labels';

const has = (key: string) => key in ja;
const t = (key: MessageKey) => ja[key];

describe('system log labels', () => {
	it('names every known source and the events the sources write', () => {
		for (const source of SYSTEM_LOG_SOURCES) {
			expect(sourceLabel(source, t, has)).not.toBe(surfaceOf(source));
		}
		for (const event of [
			'webhook.outbox.dropped',
			'directory_connector_heartbeat.failed',
			'saml.provider.metadata_refreshed',
			'saml.provider.metadata_refresh_failed',
			'saml.federation.metadata_refreshed'
		]) {
			expect(eventLabelKey(event, has), event).not.toBeNull();
		}
	});

	it('falls back to the code for an unknown source or event, and never shows nothing', () => {
		expect(surfaceOf('authrim/new_surface')).toBe('new_surface');
		expect(sourceLabel('authrim/new_surface', t, has)).toBe('new_surface');
		expect(sourceLabel('other', t, has)).toBe('other');
		expect(eventLabel('something.new', t, has)).toBe('something.new');
		expect(eventLabel('', t, has)).toBe(ja['slog.event.unknown']);
	});

	it('lists the known sources, plus the current one when it is not among them', () => {
		const options = sourceOptions(t, has, 'authrim/other');
		expect(options[0]).toEqual({ value: '', label: ja['slog.filter.source.all'] });
		expect(options.map((option) => option.value)).toEqual([
			'',
			...SYSTEM_LOG_SOURCES,
			'authrim/other'
		]);
		expect(options.at(-1)?.label).toBe('other');
	});

	it('shows only results and severities it knows', () => {
		expect(resultOf({ result: 'failure' })).toBe('failure');
		expect(resultOf({ result: 'odd' as never })).toBeNull();
		expect(severityOf({ severity: 'warn' })).toBe('warn');
		expect(severityOf({ severity: 'loud' as never })).toBeNull();
	});
});
