/**
 * The first-steps checklist: what the overview lists for a new environment, and the guide each
 * item walks through.
 *
 * THIS FILE IS THE WHOLE DEFINITION. To add, remove or reorder an item or a step, edit the list
 * below and add its texts to `#lib/i18n/messages/onboarding/*` (every language). Nothing else
 * needs to change, unless a step points at something that has no stable selector yet (then give
 * that element a `data-guide="…"` attribute) or waits for something only a page knows (then that
 * page calls `guideSignal('…')`, see `signals.ts`).
 *
 * An item's `id` is what the server keeps as finished (`/api/admin/me/onboarding`): lowercase
 * words joined by hyphens, 40 characters at most. Renaming an id makes the item unfinished again
 * for everyone, so do not rename one that has shipped.
 */
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { IconName } from '#lib/ui/icons/icons.js';
import type { GuideSignal } from './signals';

/**
 * What moves a step on:
 * - `next` (the default): the Next button.
 * - `click`: the person clicks what the step points at (or, with `clickOn`, something inside it).
 *   A tab that is already open (`aria-selected`) counts as clicked.
 * - `navigate`: the person goes to the page of a later step (opens a record, presses New).
 * - `{ signal }`: a page reports that something happened (`guideSignal`), e.g. a save succeeded.
 */
export type GuideAdvance = 'next' | 'click' | 'navigate' | { signal: GuideSignal };

export interface GuideStep {
	/**
	 * The console page the step is on. `*` stands for exactly one path segment, so
	 * `/admin/customization/branding/*` is any theme's page (and the new theme page).
	 */
	path: string;
	/**
	 * CSS selector of what to point at. Prefer `[data-guide="…"]`. Left out, or not on the page,
	 * the text is shown in the middle of the screen.
	 */
	target?: string;
	title: MessageKey;
	body: MessageKey;
	/** What the person is asked to do, shown apart from the explanation (for steps that wait). */
	action?: MessageKey;
	advance?: GuideAdvance;
	/**
	 * Where to point, and what to ask, while the target is not on the page because something
	 * else has to be opened first (a tab that hides it). When the target appears, the step
	 * points at it as usual.
	 */
	fallback?: { target: string; action: MessageKey };
	/** With `advance: 'click'`: only clicks on this selector inside the target count. */
	clickOn?: string;
	/**
	 * False for a step during which the person works all over the page ("change what you like"):
	 * the rest of the page is not dimmed. Steps that point at one thing leave it out.
	 */
	dim?: boolean;
	/** Moving on from this step finishes the item. The last step always does. */
	completes?: boolean;
}

export interface ChecklistItem {
	id: string;
	icon: IconName;
	title: MessageKey;
	description: MessageKey;
	steps: readonly GuideStep[];
}

const THEME_EDITOR = '/admin/customization/branding/*';
const SCREEN_EDITOR = '/admin/customization/screens/*';

export const CHECKLIST: readonly ChecklistItem[] = [
	{
		id: 'sign-in',
		icon: 'key',
		title: 'ob.signIn.title',
		description: 'ob.signIn.desc',
		steps: [
			{
				path: '/admin/settings/general',
				target: '[data-guide="tenant-url-login"]',
				title: 'ob.signIn.s1.title',
				body: 'ob.signIn.s1.body',
				action: 'ob.signIn.s1.action',
				advance: 'click',
				clickOn: 'a[href]'
			}
		]
	},
	{
		id: 'theme',
		icon: 'brush',
		title: 'ob.theme.title',
		description: 'ob.theme.desc',
		steps: [
			{
				path: '/admin/customization/branding',
				target: '[data-guide="theme-create"]',
				title: 'ob.theme.s1.title',
				body: 'ob.theme.s1.body',
				action: 'ob.theme.s1.action',
				advance: 'navigate'
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-sections"] [role="tab"][data-tab="layout"]',
				title: 'ob.theme.s2.title',
				body: 'ob.theme.s2.body'
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-sections"] [role="tab"][data-tab="look"]',
				title: 'ob.theme.s3.title',
				body: 'ob.theme.s3.body'
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-sections"] [role="tab"][data-tab="images"]',
				title: 'ob.theme.s4.title',
				body: 'ob.theme.s4.body',
				action: 'ob.theme.s4.action',
				advance: 'click'
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-bg-preset"]',
				title: 'ob.theme.s5.title',
				body: 'ob.theme.s5.body',
				action: 'ob.theme.s5.action',
				// The background picture is set under the light tab of the images.
				fallback: {
					target: '[data-guide="theme-image-modes"] [role="tab"][data-tab="light"]',
					action: 'ob.theme.s5.fallback'
				},
				advance: { signal: 'theme.preset-chosen' }
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-save"]',
				title: 'ob.theme.s6.title',
				body: 'ob.theme.s6.body',
				action: 'ob.theme.s6.action',
				advance: { signal: 'theme.saved' },
				dim: false
			}
		]
	},
	{
		id: 'schema',
		icon: 'list',
		title: 'ob.schema.title',
		description: 'ob.schema.desc',
		steps: [
			{
				path: '/admin/access/schema-setting',
				target: '[data-guide="schema-add"]',
				title: 'ob.schema.s1.title',
				body: 'ob.schema.s1.body',
				action: 'ob.schema.s1.action',
				advance: { signal: 'schema.saved' }
			}
		]
	},
	{
		id: 'screens',
		icon: 'device',
		title: 'ob.screens.title',
		description: 'ob.screens.desc',
		steps: [
			{
				path: '/admin/customization/screens',
				target: '[data-guide="screen-create"]',
				title: 'ob.screens.s1.title',
				body: 'ob.screens.s1.body',
				action: 'ob.screens.s1.action',
				advance: 'navigate'
			},
			{
				path: '/admin/customization/screens/new',
				title: 'ob.screens.s2.title',
				body: 'ob.screens.s2.body',
				action: 'ob.screens.s2.action',
				advance: 'navigate'
			},
			{
				path: SCREEN_EDITOR,
				target: '[data-palette-group="input"]',
				title: 'ob.screens.s3.title',
				body: 'ob.screens.s3.body',
				action: 'ob.screens.s3.action',
				advance: 'click',
				// The part itself, not the "?" beside it.
				clickOn: '.palette__part'
			},
			{
				path: SCREEN_EDITOR,
				target: '[data-guide="part-settings"]',
				title: 'ob.screens.s4.title',
				body: 'ob.screens.s4.body'
			},
			{
				path: SCREEN_EDITOR,
				target: '.save-bar',
				title: 'ob.screens.s5.title',
				body: 'ob.screens.s5.body',
				action: 'ob.screens.s5.action',
				advance: { signal: 'screen.saved' },
				dim: false
			}
		]
	}
];
