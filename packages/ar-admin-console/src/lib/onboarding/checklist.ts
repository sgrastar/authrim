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

const OVERVIEW = '/admin';
const TENANT_BASICS = '/admin/settings/general';
const THEME_LIST = '/admin/customization/branding';
const THEME_EDITOR = '/admin/customization/branding/*';
const SCHEMA_LIST = '/admin/access/schema-setting';
const SCREEN_LIST = '/admin/customization/screens';
const SCREEN_EDITOR = '/admin/customization/screens/*';

/** The left navigation's link to a page (its rows carry no name of their own). */
const subNavLink = (href: string) => `.subnav a.subnav__item[href="${href}"]`;

export const CHECKLIST: readonly ChecklistItem[] = [
	{
		id: 'sign-in',
		icon: 'key',
		title: 'ob.signIn.title',
		description: 'ob.signIn.desc',
		steps: [
			// Where things are, before going there: the category in the header (on the overview, so
			// starting the guide moves nowhere), then its page in the left navigation.
			{
				path: OVERVIEW,
				target: '[data-guide="nav-settings"]',
				title: 'ob.signIn.s1.title',
				body: 'ob.signIn.s1.body'
			},
			{
				path: TENANT_BASICS,
				target: subNavLink(TENANT_BASICS),
				title: 'ob.signIn.s2.title',
				body: 'ob.signIn.s2.body'
			},
			{
				path: TENANT_BASICS,
				target: '[data-guide="tenant-url-login"]',
				title: 'ob.signIn.s3.title',
				body: 'ob.signIn.s3.body',
				action: 'ob.signIn.s3.action',
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
				path: OVERVIEW,
				target: '[data-guide="nav-customization"]',
				title: 'ob.theme.nav.title',
				body: 'ob.theme.nav.body'
			},
			{
				path: THEME_LIST,
				target: subNavLink(THEME_LIST),
				title: 'ob.theme.sub.title',
				body: 'ob.theme.sub.body'
			},
			{
				path: THEME_LIST,
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
				// A new theme opens with its name being typed; a saved one shows a pencil to open it.
				target: '[data-guide="theme-name"]',
				title: 'ob.theme.name.title',
				body: 'ob.theme.name.body',
				action: 'ob.theme.name.action',
				fallback: {
					target: '[data-guide="theme-name-edit"]',
					action: 'ob.theme.name.fallback'
				}
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-save"]',
				title: 'ob.theme.s6.title',
				body: 'ob.theme.s6.body',
				action: 'ob.theme.s6.action',
				advance: { signal: 'theme.saved' },
				dim: false
			},
			{
				path: THEME_EDITOR,
				target: '[data-guide="theme-apply"]',
				title: 'ob.theme.apply.title',
				body: 'ob.theme.apply.body',
				action: 'ob.theme.apply.action',
				advance: { signal: 'theme.applied' }
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
				path: OVERVIEW,
				target: '[data-guide="nav-access"]',
				title: 'ob.schema.nav.title',
				body: 'ob.schema.nav.body'
			},
			{
				path: SCHEMA_LIST,
				target: subNavLink(SCHEMA_LIST),
				title: 'ob.schema.sub.title',
				body: 'ob.schema.sub.body'
			},
			{
				path: SCHEMA_LIST,
				target: '[data-guide="schema-add"]',
				title: 'ob.schema.s1.title',
				body: 'ob.schema.s1.body'
			},
			// Read, and done: nothing has to be added to finish this one.
			{
				path: SCHEMA_LIST,
				target: '[data-guide="schema-presets"]',
				title: 'ob.schema.preset.title',
				body: 'ob.schema.preset.body'
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
				path: OVERVIEW,
				target: '[data-guide="nav-customization"]',
				title: 'ob.screens.nav.title',
				body: 'ob.screens.nav.body'
			},
			{
				path: SCREEN_LIST,
				target: subNavLink(SCREEN_LIST),
				title: 'ob.screens.sub.title',
				body: 'ob.screens.sub.body'
			},
			{
				path: SCREEN_LIST,
				// The whole row of the sign-up screen (its name cell carries the mark).
				target: 'tr:has([data-guide="screen-row-registration"])',
				title: 'ob.screens.row.title',
				body: 'ob.screens.row.body',
				action: 'ob.screens.row.action',
				// A search or a filter that hides the row: point at where they are cleared.
				fallback: { target: '.filter-bar', action: 'ob.screens.row.fallback' },
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
