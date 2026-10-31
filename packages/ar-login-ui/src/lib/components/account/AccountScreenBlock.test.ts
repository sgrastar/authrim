import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AccountPageScreenField } from '$lib/api/account';
import AccountScreenBlock, { isAccountScreenStaticBlock } from './AccountScreenBlock.svelte';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

const field = (overrides: Partial<AccountPageScreenField> = {}): AccountPageScreenField => ({
	field: 'block',
	label: 'Label',
	required: false,
	...overrides
});

function renderBlock(props: Parameters<typeof AccountScreenBlock>[1]): string {
	return render(AccountScreenBlock, { props }).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountScreenBlock', () => {
	it('draws a heading with its optional text', () => {
		const body = renderBlock({
			field: field({ block_type: 'heading', label: 'Manage your account', text: 'Intro' })
		});
		expect(body).toMatch(/<h2[^>]*>Manage your account<\/h2>/);
		expect(body).toMatch(/<p[^>]*>Intro<\/p>/);

		expect(renderBlock({ field: field({ block_type: 'heading' }) })).not.toContain('<p');
	});

	it('draws text, falling back to the label', () => {
		expect(renderBlock({ field: field({ block_type: 'text', text: 'Body' }) })).toMatch(
			/<p class="account-screen__text[^"]*">Body<\/p>/
		);
		expect(renderBlock({ field: field({ block_type: 'text', text: '' }) })).toMatch(
			/<p class="account-screen__text[^"]*">Label<\/p>/
		);
	});

	it('renders only validated links', () => {
		const link = field({ block_type: 'link', label: 'Help', href: 'javascript:alert(1)' });
		expect(renderBlock({ field: link, href: '/help' })).toMatch(
			/<a [^>]*href="\/help"[^>]*>Help<\/a>/
		);
		expect(renderBlock({ field: link })).toBe('');
		expect(renderBlock({ field: link, href: null })).toBe('');
	});

	it('draws a divider with optional text and nothing for widget blocks', () => {
		expect(renderBlock({ field: field({ block_type: 'divider', text: 'or' }) })).toMatch(
			/class="account-screen__divider[^"]*"><span>or<\/span>/
		);
		expect(renderBlock({ field: field({ block_type: 'account_profile_widget' }) })).toBe('');
	});

	it('tells static blocks from widget blocks', () => {
		for (const type of ['heading', 'text', 'link', 'divider'] as const) {
			expect(isAccountScreenStaticBlock(type)).toBe(true);
		}
		expect(isAccountScreenStaticBlock('account_profile_widget')).toBe(false);
		expect(isAccountScreenStaticBlock('layout_row')).toBe(false);
		expect(isAccountScreenStaticBlock(undefined)).toBe(false);
	});
});
