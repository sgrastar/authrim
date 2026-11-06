import { describe, expect, it } from 'vitest';
import { en } from '#lib/i18n/messages/en.js';
import { ja } from '#lib/i18n/messages/ja.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import { stepUpAsker, stepUpPromptBody } from './step-up-prompt';

const translator =
	(messages: Record<string, string>) =>
	(key: MessageKey, params?: Record<string, string | number>) =>
		messages[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''));

describe('stepUpPromptBody', () => {
	it('names the level and each check once, in the order they are made', () => {
		expect(
			stepUpPromptBody({ level: 'L2', factors: ['second_factor', 'passkey'] }, translator(ja))
		).toBe(
			'この操作は L2 です。パスキー認証が 1 回、セキュリティキー認証が 1 回必要です。実施しますか？'
		);
		expect(stepUpPromptBody({ level: 'L1', factors: ['passkey'] }, translator(en))).toBe(
			'This operation is L1. It takes one passkey verification. Continue?'
		);
	});
});

describe('stepUpAsker', () => {
	const request = { level: 'L1', factors: ['passkey'] } as const;

	it('shows a request and resolves with the answer', async () => {
		const shown: unknown[] = [];
		const asker = stepUpAsker((next) => shown.push(next));
		const answer = asker.ask({ ...request, factors: [...request.factors] });
		asker.settle(true);
		await expect(answer).resolves.toBe(true);
		expect(shown).toEqual([{ level: 'L1', factors: ['passkey'] }, null]);
	});

	it('declines a request still open when a newer one comes', async () => {
		const asker = stepUpAsker(() => {});
		const older = asker.ask({ ...request, factors: ['passkey'] });
		const newer = asker.ask({ level: 'L2', factors: ['second_factor'] });
		await expect(older).resolves.toBe(false);
		asker.settle(true);
		await expect(newer).resolves.toBe(true);
	});

	it('declines what is open, and whatever asks later, once the dialog is gone', async () => {
		const asker = stepUpAsker(() => {});
		const open = asker.ask({ ...request, factors: ['passkey'] });
		asker.close();
		await expect(open).resolves.toBe(false);
		await expect(asker.ask({ ...request, factors: ['passkey'] })).resolves.toBe(false);
	});
});
