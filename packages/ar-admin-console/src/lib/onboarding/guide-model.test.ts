import { describe, expect, it } from 'vitest';
import { hasMessage } from '#lib/i18n/i18n.svelte.js';
import { CHECKLIST, type ChecklistItem, type GuideStep } from './checklist';
import {
	canGoBack,
	escapeHtml,
	isConcretePath,
	locateStep,
	matchesPath,
	moveOn,
	moveOnSignal,
	waitsForPerson
} from './guide-model';

const step = (path: string, extra: Partial<GuideStep> = {}): GuideStep => ({
	path,
	title: 'ob.title',
	body: 'ob.lead',
	...extra
});

const item = (steps: GuideStep[]): ChecklistItem => ({
	id: 'sample',
	icon: 'list',
	title: 'ob.title',
	description: 'ob.lead',
	steps
});

describe('matchesPath', () => {
	it('matches a page by its segments, a star standing for exactly one', () => {
		expect(matchesPath('/admin/a', '/admin/a')).toBe(true);
		expect(matchesPath('/admin/a', '/admin/a/')).toBe(true);
		expect(matchesPath('/admin/a/*', '/admin/a/new')).toBe(true);
		expect(matchesPath('/admin/a/*', '/admin/a')).toBe(false);
		expect(matchesPath('/admin/a/*', '/admin/a/b/c')).toBe(false);
		expect(matchesPath('/admin/a', '/admin/b')).toBe(false);
	});

	it('tells the paths the guide can go to by itself', () => {
		expect(isConcretePath('/admin/a')).toBe(true);
		expect(isConcretePath('/admin/a/*')).toBe(false);
	});
});

describe('locateStep', () => {
	const steps = [step('/list'), step('/list/new'), step('/list/*'), step('/list/*')];

	it('stays on the current step while its page is shown', () => {
		expect(locateStep(steps, 2, '/list/abc')).toBe(2);
		expect(locateStep(steps, 3, '/list/abc')).toBe(3);
	});

	it('moves to the nearest later step of the page the person opened', () => {
		expect(locateStep(steps, 0, '/list/new')).toBe(1);
		// Opening a record skips the step that is only for the new page.
		expect(locateStep(steps, 0, '/list/abc')).toBe(2);
	});

	it('falls back to an earlier step when the person went back', () => {
		expect(locateStep(steps, 3, '/list')).toBe(0);
	});

	it('shows nothing on a page that is not the guide’s', () => {
		expect(locateStep(steps, 1, '/elsewhere')).toBeNull();
		expect(locateStep(steps, 9, '/list')).toBeNull();
	});
});

describe('moving on', () => {
	const sample = item([
		step('/a'),
		step('/a', { advance: { signal: 'theme.preset-chosen' } }),
		step('/a', { advance: { signal: 'theme.saved' }, completes: true }),
		step('/a')
	]);

	it('goes to the next step, and finishes after the last or a completing one', () => {
		expect(moveOn(sample, 0)).toEqual({ kind: 'step', index: 1 });
		expect(moveOn(sample, 2)).toEqual({ kind: 'finish' });
		expect(moveOn(sample, 3)).toEqual({ kind: 'finish' });
	});

	it('follows a signal the current or a later step waits for', () => {
		expect(moveOnSignal(sample, 1, 'theme.preset-chosen')).toEqual({ kind: 'step', index: 2 });
		// Saved before the guide asked for it: still saved.
		expect(moveOnSignal(sample, 0, 'theme.saved')).toEqual({ kind: 'finish' });
	});

	it('ignores a signal nothing from here on waits for', () => {
		expect(moveOnSignal(sample, 2, 'theme.preset-chosen')).toBeNull();
		expect(moveOnSignal(sample, 0, 'schema.saved')).toBeNull();
	});

	it('offers Back only within the page', () => {
		const steps = [step('/a'), step('/b'), step('/b')];
		expect(canGoBack(steps, 0, '/a')).toBe(false);
		expect(canGoBack(steps, 1, '/b')).toBe(false);
		expect(canGoBack(steps, 2, '/b')).toBe(true);
	});

	it('knows the steps that wait for the person', () => {
		expect(waitsForPerson(step('/a'))).toBe(false);
		expect(waitsForPerson(step('/a', { advance: 'next' }))).toBe(false);
		expect(waitsForPerson(step('/a', { advance: 'click' }))).toBe(true);
		expect(waitsForPerson(step('/a', { advance: 'navigate' }))).toBe(true);
	});
});

describe('escapeHtml', () => {
	it('keeps text as text', () => {
		expect(escapeHtml('<b>"a" & b</b>')).toBe('&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;');
	});
});

describe('the console’s checklist', () => {
	it('opens every guide on the overview with the header category, then the left navigation', () => {
		const category: Record<string, string> = {
			'sign-in': 'nav-settings',
			theme: 'nav-customization',
			schema: 'nav-access',
			screens: 'nav-customization'
		};
		for (const entry of CHECKLIST) {
			const [first, second] = entry.steps;
			expect(first.path).toBe('/admin');
			expect(first.target).toBe(`[data-guide="${category[entry.id]}"]`);
			expect(isConcretePath(second.path)).toBe(true);
			expect(second.target).toBe(`.subnav a.subnav__item[href="${second.path}"]`);
			expect(waitsForPerson(first) || waitsForPerson(second)).toBe(false);
		}
	});

	it('ends the theme guide with a name, a save and the apply; the schema guide by reading', () => {
		const steps = (id: string) => CHECKLIST.find((entry) => entry.id === id)?.steps ?? [];
		expect(
			steps('theme')
				.slice(-3)
				.map((entry) => entry.target)
		).toEqual([
			'[data-guide="theme-name"]',
			'[data-guide="theme-save"]',
			'[data-guide="theme-apply"]'
		]);
		expect(
			steps('theme')
				.slice(-2)
				.map((entry) => entry.advance)
		).toEqual([{ signal: 'theme.saved' }, { signal: 'theme.applied' }]);
		// Nothing has to be added to finish the schema guide: its steps all offer Next.
		expect(steps('schema').some(waitsForPerson)).toBe(false);
		expect(steps('schema').at(-1)?.target).toBe('[data-guide="schema-presets"]');
		// The screens guide opens the sign-up screen from the list.
		expect(steps('screens')[2]).toMatchObject({
			target: 'tr:has([data-guide="screen-row-registration"])',
			advance: 'navigate'
		});
	});

	it('starts the sign-in guide on the overview and leads through the navigation to the link', () => {
		const signIn = CHECKLIST.find((entry) => entry.id === 'sign-in');
		const steps = signIn?.steps ?? [];
		expect(steps.map((entry) => entry.path)).toEqual([
			'/admin',
			'/admin/settings/general',
			'/admin/settings/general'
		]);
		// Started from the checklist: the first step is on that page, so nothing moves.
		expect(locateStep(steps, 0, '/admin')).toBe(0);
		// Next names a page the guide can go to; a person who uses the header instead lands there too.
		expect(isConcretePath(steps[1].path)).toBe(true);
		expect(locateStep(steps, 0, '/admin/settings/general')).toBe(1);
		expect(steps.slice(0, 2).every((entry) => !waitsForPerson(entry))).toBe(true);
		// Only the link finishes it, and only by being opened.
		expect(moveOn(signIn as ChecklistItem, 1)).toEqual({ kind: 'step', index: 2 });
		expect(steps[2]).toMatchObject({ advance: 'click', clickOn: 'a[href]' });
		expect(canGoBack(steps, 2, '/admin/settings/general')).toBe(true);
		expect(canGoBack(steps, 1, '/admin/settings/general')).toBe(false);
	});

	it('has ids the server accepts, each once', () => {
		const ids = CHECKLIST.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
			expect(id.length).toBeLessThanOrEqual(40);
		}
	});

	it('has texts for everything it shows, and steps the guide can run', () => {
		for (const entry of CHECKLIST) {
			expect(entry.steps.length).toBeGreaterThan(0);
			// The guide goes to the first step's page by itself.
			expect(isConcretePath(entry.steps[0].path)).toBe(true);
			for (const key of [entry.title, entry.description]) expect(hasMessage(key)).toBe(true);
			entry.steps.forEach((entryStep, index) => {
				// A console page: the overview (where the checklist is) or one below it.
				expect(entryStep.path).toMatch(/^\/admin(\/|$)/);
				for (const key of [
					entryStep.title,
					entryStep.body,
					entryStep.action,
					entryStep.fallback?.action
				]) {
					if (key) expect(hasMessage(key)).toBe(true);
				}
				// A step that waits says what it waits for.
				if (waitsForPerson(entryStep)) expect(entryStep.action).toBeTruthy();
				// A page the guide cannot name is reached by the person, from the step before.
				if (index > 0 && !isConcretePath(entryStep.path)) {
					const before = entry.steps[index - 1];
					expect(
						before.path === entryStep.path || before.advance === 'navigate',
						`${entry.id} step ${index + 1}`
					).toBe(true);
				}
				if (entryStep.advance === 'click') expect(entryStep.target).toBeTruthy();
			});
		}
	});
});
