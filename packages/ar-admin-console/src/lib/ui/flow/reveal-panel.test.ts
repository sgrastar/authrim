import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealPanel } from './reveal-panel';

const panelAt = (top: number) =>
	({ getBoundingClientRect: () => ({ top }) }) as unknown as HTMLElement;

describe('revealPanel', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	/** The bars at the top: a header bar and, on a wide screen, the category bar under it. */
	function setup(bars: { topbar?: number; topnav?: number }) {
		document.body.innerHTML = '<header class="topbar"></header><nav class="topnav"></nav>';
		for (const [name, bottom] of Object.entries(bars)) {
			document.querySelector(`.${name}`)!.getBoundingClientRect = () => ({ bottom }) as DOMRect;
		}
		return vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
	}

	it('scrolls to the top when the panel is under the fixed header', () => {
		const scroll = setup({ topbar: 56, topnav: 104 });
		revealPanel(panelAt(-300));
		expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
		scroll.mockClear();
		revealPanel(panelAt(60));
		expect(scroll).toHaveBeenCalledOnce();
	});

	it('leaves the page alone when the top of the panel is in view', () => {
		const scroll = setup({ topbar: 56, topnav: 104 });
		revealPanel(panelAt(104));
		revealPanel(panelAt(400));
		expect(scroll).not.toHaveBeenCalled();
	});

	it('does nothing without a panel', () => {
		const scroll = setup({ topbar: 56, topnav: 104 });
		revealPanel(null);
		expect(scroll).not.toHaveBeenCalled();
	});

	it('uses the header bar alone when the categories are not shown (a phone)', () => {
		// The category bar is hidden, so it measures 0; the header bar still covers the top 56px.
		const scroll = setup({ topbar: 56, topnav: 0 });
		revealPanel(panelAt(30));
		expect(scroll).toHaveBeenCalledOnce();
		scroll.mockClear();
		revealPanel(panelAt(80));
		expect(scroll).not.toHaveBeenCalled();
	});

	it('ignores a bar that has scrolled out of view', () => {
		const scroll = setup({ topbar: -200, topnav: 104 });
		revealPanel(panelAt(120));
		expect(scroll).not.toHaveBeenCalled();
	});
});
