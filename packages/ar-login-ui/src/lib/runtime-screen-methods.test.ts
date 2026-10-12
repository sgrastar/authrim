import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEmailFieldEnter } from './login-email-enter';
import {
	isDisplayConditionMet,
	shownEntryMethods,
	type RuntimeScreenBlock,
	type RuntimeScreenAuthMethod
} from './runtime-screen-methods';

const all = () => true;
const widget = (auth_method: string, hidden = false): RuntimeScreenBlock => ({
	block_type: 'auth_widget',
	auth_method,
	display_condition: hidden ? { mode: 'hidden' } : { mode: 'always' }
});

// What RuntimeScreen keeps: blocks whose display condition holds.
function shownOnScreen(
	blocks: RuntimeScreenBlock[],
	isAvailable: (method: RuntimeScreenAuthMethod) => boolean = all
) {
	return shownEntryMethods(
		blocks.filter((block) => isDisplayConditionMet(block, isAvailable)),
		isAvailable
	);
}

describe('display conditions', () => {
	it('hides a block with mode hidden, shows always / none, follows feature_enabled', () => {
		const block = (display_condition: RuntimeScreenBlock['display_condition']) => ({
			block_type: 'auth_widget',
			display_condition
		});
		expect(isDisplayConditionMet(block({ mode: 'hidden' }), all)).toBe(false);
		expect(isDisplayConditionMet(block({ mode: 'always' }), all)).toBe(true);
		expect(isDisplayConditionMet(block(undefined), all)).toBe(true);
		expect(isDisplayConditionMet(block({ mode: 'feature_enabled', feature: 'totp' }), all)).toBe(
			true
		);
		expect(
			isDisplayConditionMet(
				block({ mode: 'feature_enabled', feature: 'totp' }),
				(method) => method !== 'totp'
			)
		).toBe(false);
		expect(isDisplayConditionMet(block({ mode: 'feature_enabled', feature: null }), all)).toBe(
			false
		);
	});
});

describe('the methods a screen shows decide Enter in the email field', () => {
	const passkey = widget('passkey');
	it.each([
		['email code and authenticator app widgets', [widget('mail_otp'), widget('totp')], 'ignore'],
		['a combined widget', [widget('mail_otp_totp')], 'ignore'],
		['only the email code widget', [passkey, widget('mail_otp')], 'send_email_code'],
		['only the authenticator app widget', [passkey, widget('totp')], 'start_totp'],
		[
			'the email code widget hidden, authenticator app shown',
			[passkey, widget('mail_otp', true), widget('totp')],
			'start_totp'
		],
		[
			'the authenticator app widget hidden, email code shown',
			[passkey, widget('mail_otp'), widget('totp', true)],
			'send_email_code'
		],
		[
			'the email code widget hidden (authenticator app not offered at all)',
			[passkey, widget('mail_otp', true)],
			'ignore'
		],
		['both hidden', [passkey, widget('mail_otp', true), widget('totp', true)], 'ignore'],
		['no widgets', [], 'ignore'],
		['a passkey widget only', [passkey], 'ignore']
	])('%s', (_name, blocks, expected) => {
		expect(resolveEmailFieldEnter(shownOnScreen(blocks))).toBe(expected);
	});

	it('follows availability inside a combined widget', () => {
		const onlyTotp = (method: RuntimeScreenAuthMethod) => method !== 'mail_otp';
		expect(shownOnScreen([widget('mail_otp_totp')], onlyTotp)).toEqual({
			emailCode: false,
			totp: true
		});
		const onlyMail = (method: RuntimeScreenAuthMethod) => method !== 'totp';
		expect(shownOnScreen([widget('mail_otp_totp')], onlyMail)).toEqual({
			emailCode: true,
			totp: false
		});
	});

	it('ignores blocks that are not authentication widgets', () => {
		expect(
			shownOnScreen([{ block_type: 'identity_field' }, { block_type: 'heading' }, {}])
		).toEqual({ emailCode: false, totp: false });
	});

	it('treats an unknown method as the passkey', () => {
		expect(shownOnScreen([widget('something_else')])).toEqual({ emailCode: false, totp: false });
	});
});

describe('RuntimeScreen draws with the same rules', () => {
	const source = readFileSync(resolve(__dirname, 'components/RuntimeScreen.svelte'), 'utf8');

	it('uses the shared display rule and reads the shown methods from the sections it draws', () => {
		expect(source).toContain('return isDisplayConditionMet(field, authMethodAvailable);');
		expect(source).toContain('return readAuthWidgetMethod(field);');
		expect(source).toMatch(
			/shownEntryMethods\(\s*renderedSections\.flatMap\(\(section\) => section\.items\),\s*authMethodAvailable\s*\)/
		);
		expect(source).toContain('shownAuthMethods = shownEntries;');
	});
});
