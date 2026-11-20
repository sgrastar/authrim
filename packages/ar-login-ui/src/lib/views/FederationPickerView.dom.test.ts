// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FederationPickerView from './FederationPickerView.svelte';

const items = [
	{ entityId: 'https://idp.u-alpha.example/idp', displayName: 'Alpha University', logoUrl: null },
	{ entityId: 'https://idp.beta.example/idp', displayName: 'Beta Institute', logoUrl: null }
];

function mount(props: Partial<Parameters<typeof FederationPickerView>[1]> = {}) {
	const onSelect = vi.fn();
	const onQuery = vi.fn();
	render(FederationPickerView, {
		props: { federationName: 'Research Federation', items, query: '', onSelect, onQuery, ...props }
	});
	return { onSelect, onQuery };
}

describe('FederationPickerView', () => {
	it('lists the institutions and reports the one chosen by its entityID', async () => {
		const { onSelect } = mount();
		await userEvent.click(screen.getByRole('button', { name: /Beta Institute/ }));
		expect(onSelect).toHaveBeenCalledWith('https://idp.beta.example/idp');
	});

	it('reports what is typed', async () => {
		const { onQuery } = mount();
		await userEvent.type(screen.getByRole('searchbox'), 'al');
		expect(onQuery).toHaveBeenLastCalledWith('al');
	});

	it('says so when nothing matches, and does not say so while loading or after a failure', () => {
		const { container } = (() => {
			mount({ items: [] });
			return { container: document.body };
		})();
		expect(container.textContent).toContain('No institution matches your search.');
	});

	it('shows only a failure message when the list could not be loaded', () => {
		mount({ items: [], loadFailed: true });
		expect(document.body.textContent).toContain('could not be loaded');
		expect(document.body.textContent).not.toContain('No institution matches');
	});

	it('does not render a logo from an address that is not a safe image URL', () => {
		mount({
			items: [
				{ entityId: 'urn:x', displayName: 'Logo Inst', logoUrl: 'javascript:alert(1)' },
				{ entityId: 'urn:y', displayName: 'Safe Inst', logoUrl: 'https://img.example/logo.png' }
			]
		});
		const logos = document.querySelectorAll('img');
		expect(logos).toHaveLength(1);
		expect(logos[0]?.getAttribute('src')).toBe('https://img.example/logo.png');
	});
});
