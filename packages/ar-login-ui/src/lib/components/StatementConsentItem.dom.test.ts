// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import StatementConsentItem from './StatementConsentItem.svelte';

const ITEM = {
	statement_id: 'st-terms',
	slug: 'terms',
	title: 'Terms of Service',
	description: '',
	version: '20261113',
	document_url: null,
	inline_content: '<p>The full text.</p><script>alert(1)</script>'
};

// jsdom has no layout: a text 1000px tall in a 100px box, so it has an end to scroll to.
function tallBoxes() {
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
}

function scrollToEnd(element: Element) {
	(element as HTMLElement).scrollTop = 900;
	return fireEvent.scroll(element);
}

beforeEach(() => {
	setLocale('en');
	// jsdom does not draw a dialog: the `open` attribute is all the component needs of it.
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open');
	};
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('StatementConsentItem presentation', () => {
	it('keeps the statement page frame when the widget asks for nothing special', () => {
		const view = render(StatementConsentItem, { props: { item: ITEM, asks: true } });
		expect(view.getByTitle('Terms of Service').tagName).toBe('IFRAME');
		expect((view.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
			false
		);
	});

	describe('in a box, scrolled to the end first', () => {
		it('locks the box until the end of the text, and says so', async () => {
			tallBoxes();
			const onchange = vi.fn();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, requireScroll: true, onchange }
			});
			// A scroll box drawn here (never a frame whose scroll cannot be seen), without a script.
			expect(view.container.querySelector('iframe')).toBeNull();
			expect(view.container.querySelector('script')).toBeNull();
			expect(view.getByText('The full text.')).toBeTruthy();
			expect((view.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
				true
			);
			expect(view.getByText('Scroll to the end to agree.')).toBeTruthy();

			await scrollToEnd(view.getByRole('region', { name: 'Terms of Service' }));
			await waitFor(() =>
				expect((view.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
					false
				)
			);
			expect(view.queryByText('Scroll to the end to agree.')).toBeNull();
			await fireEvent.click(view.getByRole('checkbox'));
			expect(onchange).toHaveBeenCalledWith(true);
		});

		it('is open at once when the text fits without scrolling', async () => {
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, requireScroll: true }
			});
			await waitFor(() =>
				expect((view.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
					false
				)
			);
		});

		it('opens when a resize makes the whole text fit, with no scroll event', async () => {
			const callbacks: Array<() => void> = [];
			vi.stubGlobal(
				'ResizeObserver',
				class {
					constructor(callback: () => void) {
						callbacks.push(callback);
					}
					observe() {}
					disconnect() {}
				}
			);
			tallBoxes();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, requireScroll: true }
			});
			expect((view.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
			// The window grows: the text now fits in its box.
			vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100);
			callbacks.forEach((callback) => callback());
			await waitFor(() =>
				expect((view.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false)
			);
			vi.unstubAllGlobals();
		});

		it('does not lock an answer already given', () => {
			tallBoxes();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, requireScroll: true, checked: true }
			});
			expect((view.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
				false
			);
		});
	});

	describe('in a dialog', () => {
		it('opens the text instead of ticking, and the agree button ticks and closes', async () => {
			const onchange = vi.fn();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, display: 'modal', onchange }
			});
			// No text in place: only the button.
			expect(view.container.querySelector('iframe')).toBeNull();
			const dialog = view.container.ownerDocument.querySelector('dialog') as HTMLDialogElement;
			expect(dialog.hasAttribute('open')).toBe(false);

			await fireEvent.click(view.getByRole('checkbox'));
			expect(onchange).not.toHaveBeenCalled();
			expect(dialog.hasAttribute('open')).toBe(true);

			await fireEvent.click(view.getByRole('button', { name: 'I agree' }));
			expect(onchange).toHaveBeenCalledWith(true);
			expect(dialog.hasAttribute('open')).toBe(false);
		});

		it('opens from its button, and closing it agrees to nothing', async () => {
			const onchange = vi.fn();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, display: 'modal', onchange }
			});
			await fireEvent.click(view.getByRole('button', { name: 'Open Terms of Service' }));
			const dialog = view.container.ownerDocument.querySelector('dialog') as HTMLDialogElement;
			expect(dialog.hasAttribute('open')).toBe(true);
			await fireEvent.click(view.getByRole('button', { name: 'Close' }));
			expect(dialog.hasAttribute('open')).toBe(false);
			expect(onchange).not.toHaveBeenCalled();
		});

		it('keeps its agree button off until the end of the text, when asked', async () => {
			tallBoxes();
			const onchange = vi.fn();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, display: 'modal', requireScroll: true, onchange }
			});
			await fireEvent.click(view.getByRole('button', { name: 'Open Terms of Service' }));
			expect(
				(view.getByRole('button', { name: 'I agree' }) as HTMLButtonElement | HTMLInputElement)
					.disabled
			).toBe(true);

			const bodies = view.getAllByRole('region', { name: 'Terms of Service' });
			await scrollToEnd(bodies[bodies.length - 1]);
			await waitFor(() =>
				expect(
					(view.getByRole('button', { name: 'I agree' }) as HTMLButtonElement | HTMLInputElement)
						.disabled
				).toBe(false)
			);
			await fireEvent.click(view.getByRole('button', { name: 'I agree' }));
			expect(onchange).toHaveBeenCalledWith(true);
		});

		it('lets a ticked box be unticked directly', async () => {
			const onchange = vi.fn();
			const view = render(StatementConsentItem, {
				props: { item: ITEM, asks: true, display: 'modal', checked: true, onchange }
			});
			await fireEvent.click(view.getByRole('checkbox'));
			expect(onchange).toHaveBeenCalledWith(false);
		});
	});

	it('leaves a link to an external document and a statement with no text as they were', () => {
		const external = render(StatementConsentItem, {
			props: {
				item: { ...ITEM, inline_content: null, document_url: 'https://example.com/t' },
				asks: true,
				display: 'modal',
				requireScroll: true,
				linkDocument: true
			}
		});
		expect(external.getByRole('link').getAttribute('href')).toBe('https://example.com/t');
		expect(external.queryByRole('button', { name: /Open/ })).toBeNull();
		expect((external.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
			false
		);
		cleanup();

		const plain = render(StatementConsentItem, {
			props: {
				item: { ...ITEM, inline_content: null },
				asks: true,
				display: 'modal',
				requireScroll: true
			}
		});
		expect(plain.queryByRole('button', { name: /Open/ })).toBeNull();
		expect((plain.getByRole('checkbox') as HTMLButtonElement | HTMLInputElement).disabled).toBe(
			false
		);
	});
});
