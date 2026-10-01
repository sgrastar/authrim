import type { Preview } from '@storybook/sveltekit';
import { GLOBALS_UPDATED, SET_GLOBALS } from 'storybook/internal/core-events';
import { addons } from 'storybook/preview-api';
import '../src/lib/ui/styles.css';
import './preview.css';
import { adminAccess } from '../src/lib/access/admin-access.svelte';
import { DEFAULT_PERSONA, persona, PERSONAS } from '../src/lib/access/personas';
import { i18n } from '../src/lib/i18n/i18n.svelte';
import { enSettings } from '../src/lib/i18n/messages/settings/en';
import { isSupportedLocale, LOCALE_LABELS, SUPPORTED_LOCALES } from '../src/lib/i18n/locales';
import { applyThemeAttributes } from '../src/lib/ui/theme/theme-config';

/** Toolbar-only check language: English pseudo-localised (src/lib/i18n/pseudo.ts). */
const PSEUDO = 'pseudo';

const LOOKS = [
	{ value: 'standard', title: 'Standard' },
	{ value: 'swiss-grid', title: 'Swiss Grid' },
	{ value: 'frosted', title: 'Frosted' }
];

function applyGlobals(globals: Record<string, unknown>): void {
	const scheme = globals.scheme === 'dark' ? 'dark' : 'light';
	const look = typeof globals.look === 'string' ? globals.look : 'standard';
	applyThemeAttributes(document.documentElement, scheme, scheme, look);
	// Look at the console as this kind of admin: navigation and pages follow its access.
	adminAccess.setOverride(persona(globals.admin).access);
	if (globals.locale === PSEUDO) {
		if (!i18n.pseudo) i18n.setPseudo(true);
		return;
	}
	if (i18n.pseudo) i18n.setPseudo(false);
	const locale = isSupportedLocale(globals.locale) ? globals.locale : 'ja';
	if (i18n.locale !== locale) i18n.set(locale);
}

// Docs pages without stories (Tokens/Themes, Design rules) run no decorator, so the toolbar
// would not reach them: follow the globals from the channel as well.
const channel = addons.getChannel();
channel.on(SET_GLOBALS, ({ globals }: { globals: Record<string, unknown> }) =>
	applyGlobals(globals)
);
channel.on(GLOBALS_UPDATED, ({ globals }: { globals: Record<string, unknown> }) =>
	applyGlobals(globals)
);

/** Up to this many choices show as one wrapped row of radios; more become a dropdown. */
const MAX_INLINE_CHOICES = 3;

type ArgTypesEnhancer = NonNullable<Preview['argTypesEnhancers']>[number];

/**
 * Storybook gives every union prop a vertical radio list, however long (Icon has 90+ names).
 * Choose the control by the number of choices instead, for every component at once.
 */
const choiceControls: ArgTypesEnhancer = ({ argTypes }) =>
	Object.fromEntries(
		Object.entries(argTypes).map(([name, argType]) => {
			const control = typeof argType.control === 'string' ? argType.control : argType.control?.type;
			const type = argType.type as { name?: string; value?: unknown } | undefined;
			const options =
				argType.options ??
				(type?.name === 'enum' && Array.isArray(type.value) ? type.value : undefined);
			if (!options || !['radio', 'inline-radio', 'select'].includes(String(control))) {
				return [name, argType];
			}
			const next = options.length > MAX_INLINE_CHOICES ? 'select' : 'inline-radio';
			return [name, { ...argType, options, control: { type: next } }];
		})
	);

const preview: Preview = {
	argTypesEnhancers: [choiceControls],
	globalTypes: {
		look: {
			description: 'Theme',
			toolbar: { title: 'Theme', icon: 'paintbrush', items: LOOKS, dynamicTitle: true }
		},
		scheme: {
			description: 'Light / dark',
			toolbar: {
				title: 'Scheme',
				icon: 'contrast',
				items: [
					{ value: 'light', title: 'Light', icon: 'sun' },
					{ value: 'dark', title: 'Dark', icon: 'moon' }
				],
				dynamicTitle: true
			}
		},
		admin: {
			description:
				'Kind of admin: what they may see and change (navigation items, pages, view-only values)',
			toolbar: {
				title: 'Admin',
				icon: 'user',
				items: PERSONAS.map((p) => ({ value: p.id, title: enSettings[p.label] })),
				dynamicTitle: true
			}
		},
		locale: {
			description:
				'Language (ar switches to right-to-left; Pseudo shows English stretched and accented to find hard-coded text and cut-off labels)',
			toolbar: {
				title: 'Language',
				icon: 'globe',
				items: [
					...SUPPORTED_LOCALES.map((value) => ({
						value,
						title: `${LOCALE_LABELS[value].short} ${LOCALE_LABELS[value].native}`
					})),
					{ value: PSEUDO, title: 'Pseudo (layout check)' }
				],
				dynamicTitle: true
			}
		}
	},
	initialGlobals: { look: 'standard', scheme: 'light', locale: 'ja', admin: DEFAULT_PERSONA },
	// Globals are applied before the story renders (state cannot change during Svelte's render
	// phase). The decorator re-applies them after toolbar changes, outside the render pass.
	beforeEach: ({ globals }) => applyGlobals(globals),
	decorators: [
		(story, context) => {
			queueMicrotask(() => applyGlobals(context.globals));
			return story();
		}
	],
	parameters: {
		layout: 'padded',
		options: {
			// Bottom-up: read the system the way it is built.
			storySort: {
				order: [
					'Introduction',
					'Design rules',
					'Tokens',
					['Themes', 'Scales', 'Icons'],
					'Primitives',
					['*', 'All themes'],
					'Patterns',
					['*', 'All themes'],
					'Templates',
					'Pages',
					'Shell'
				]
			}
		},
		controls: { matchers: { color: /(background|color)$/i } },
		a11y: {
			// Fail story tests on accessibility violations, not just report them.
			test: 'error'
		}
	}
};

export default preview;
