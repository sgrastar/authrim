import { describe, expect, it } from 'vitest';
import { hasMessage, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
import { CHECKLIST, type ChecklistItem, type GuideStep } from './checklist';
import {
	canGoBack,
	escapeHtml,
	isConcretePath,
	locateStep,
	matchesPath,
	moveOn,
	moveOnSignal,
	waitsForPerson,
	wordingOf
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
		// The second-factor guide leads through the account menu, not the navigation (below).
		for (const entry of CHECKLIST.filter((candidate) => candidate.id in category)) {
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

	it('names every step in the list of steps, and a step titled as a sentence has a short name', () => {
		for (const entry of CHECKLIST) {
			for (const entryStep of entry.steps) {
				if (entryStep.label) expect(hasMessage(entryStep.label)).toBe(true);
				// The steps that point at a header category are titled "… is here": named by place.
				if (entryStep.target?.startsWith('[data-guide="nav-')) expect(entryStep.label).toBeTruthy();
			}
		}
		// Steps named by place, and the two that save what was made.
		const labelled = CHECKLIST.flatMap((entry) => entry.steps.map((entryStep) => entryStep.label));
		for (const key of [
			'ob.theme.sub.label',
			'ob.theme.s2.label',
			'ob.theme.s3.label',
			'ob.theme.s4.label',
			'ob.theme.s6.label',
			'ob.schema.sub.label',
			'ob.screens.sub.label',
			'ob.screens.s5.label',
			'ob.secondFactor.settings.label'
		]) {
			expect(labelled).toContain(key);
		}
		// The label is a name, not the sentence the popover is titled with.
		const first = CHECKLIST[0].steps[0];
		expect(first.label).toBeTruthy();
		expect(t(first.label as MessageKey)).not.toBe(t(first.title));
		expect(t(first.label as MessageKey).length).toBeLessThan(t(first.title).length);
	});

	it('lists the second-factor guide fifth, through the account menu to the security keys', () => {
		expect(CHECKLIST.map((entry) => entry.id)).toEqual([
			'sign-in',
			'theme',
			'schema',
			'screens',
			'second-factor'
		]);
		const secondFactor = CHECKLIST[4];
		const steps = secondFactor.steps;
		// On the overview, so starting it moves nowhere: open the menu, then personal settings.
		expect(steps.slice(0, 2).map((entry) => entry.path)).toEqual(['/admin', '/admin']);
		expect(steps[0]).toMatchObject({
			target: '[data-guide="account-menu"]',
			advance: 'click'
		});
		expect(steps[1]).toMatchObject({
			target: '[data-guide="account-settings"]',
			advance: 'navigate',
			// The menu closing again points back at what opens it.
			fallback: { target: '[data-guide="account-menu"]' }
		});
		expect(steps.slice(2).map((entry) => entry.path)).toEqual(['/admin/me', '/admin/me']);
		// Only a second factor that was registered finishes it.
		expect(steps[3]).toMatchObject({ advance: { signal: 'second-factor.added' } });
		expect(moveOnSignal(secondFactor, 0, 'second-factor.added')).toEqual({ kind: 'finish' });
		expect(moveOnSignal(secondFactor, 3, 'second-factor.added')).toEqual({ kind: 'finish' });
		expect(steps.some((entry) => entry.completes)).toBe(false);
	});

	it('mentions an authenticator app only where one can be registered', () => {
		const steps = CHECKLIST[4].steps;
		const wording = (index: number, totp: boolean) =>
			wordingOf(steps[index], (fact) => fact === 'second-factor.totp' && totp);
		for (const index of [2, 3]) {
			expect(steps[index].variants).toEqual([
				expect.objectContaining({ when: 'second-factor.blocked' }),
				{ when: 'second-factor.totp', body: expect.stringMatching(/Totp$/) }
			]);
			expect(wording(index, false).body).toBe(steps[index].body);
			expect(wording(index, true).body).not.toBe(steps[index].body);
		}
		// Where nothing can be registered, that wins over an app being on offer, and names neither.
		const both = (index: number) => wordingOf(steps[index], () => true);
		expect(both(2).body).toBe(steps[2].variants?.[0].body);
		expect(t(both(2).body)).not.toMatch(/TOTP/);
		expect(both(3).action).toBe(steps[3].variants?.[0].action);
		expect(both(3).action).not.toBe(steps[3].action);
		expect(t(both(3).body)).not.toMatch(/TOTP/);
		// The words themselves: the variant names TOTP, the plain text does not.
		expect(t(wording(2, true).body)).toMatch(/TOTP/);
		expect(t(wording(2, false).body)).not.toMatch(/TOTP/);
		expect(t(wording(3, true).body)).toMatch(/TOTP/);
		expect(t(wording(3, false).body)).not.toMatch(/TOTP/);
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
					entryStep.fallback?.action,
					...(entryStep.variants ?? []).flatMap((variant) => [variant.body, variant.action])
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

describe('wordingOf', () => {
	const worded = step('/admin/a', {
		body: 'ob.lead',
		action: 'ob.stop',
		variants: [
			{ when: 'second-factor.totp', body: 'ob.title' },
			{ when: 'second-factor.totp', body: 'ob.next', action: 'ob.back' }
		]
	});

	it('is the step as written while no fact holds', () => {
		expect(wordingOf(worded, () => false)).toEqual({ body: 'ob.lead', action: 'ob.stop' });
		expect(wordingOf(step('/admin/a'), () => true)).toEqual({
			body: 'ob.lead',
			action: undefined
		});
	});

	it('takes the first variant whose fact holds, keeping the action it does not replace', () => {
		expect(wordingOf(worded, (fact) => fact === 'second-factor.totp')).toEqual({
			body: 'ob.title',
			action: 'ob.stop'
		});
		const second = { ...worded, variants: worded.variants?.slice(1) };
		expect(wordingOf(second, () => true)).toEqual({ body: 'ob.next', action: 'ob.back' });
	});
});
