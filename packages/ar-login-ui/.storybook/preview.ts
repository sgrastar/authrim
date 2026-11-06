import type { Preview } from '@storybook/sveltekit';
import { GLOBALS_UPDATED, SET_GLOBALS } from 'storybook/internal/core-events';
import { addons } from 'storybook/preview-api';
import 'virtual:uno.css';
import '../src/app.css';
import './preview.css';
import { setLocale } from '../src/i18n/i18n-svelte';
import { installFakeCaptcha } from '../src/lib/storybook/fake-captcha';
import {
	LOGIN_UI_LOCALE_LABELS,
	LOGIN_UI_LOCALES,
	isLoginUILocale,
	toDocumentDirection
} from '../src/lib/i18n/locales';
import { PALETTE_BACKGROUNDS } from '../src/lib/palettes';
import {
	PALETTES,
	PALETTE_LABELS,
	TEMPLATES,
	TEMPLATE_LABELS,
	paletteFrom,
	sbGlobals,
	templateFrom
} from '../src/lib/storybook/globals.svelte';

installFakeCaptcha();

function applyGlobals(globals: Record<string, unknown>): void {
	sbGlobals.template = templateFrom(globals.template);
	sbGlobals.palette = paletteFrom(globals.palette);
	sbGlobals.scheme = globals.scheme === 'dark' ? 'dark' : 'light';
	const locale = typeof globals.locale === 'string' ? globals.locale : 'ja';
	sbGlobals.locale = isLoginUILocale(locale) ? locale : 'ja';
	setLocale(sbGlobals.locale);

	// The stores are kept off <html> (see main.ts), so the canvas background follows the toolbar here.
	// Only the colour is set: a `data-login-theme` on <html> would make the palette's element rules
	// match every boundary inside it, a gallery cell with another palette included.
	const root = document.documentElement;
	root.setAttribute('data-theme', sbGlobals.scheme);
	root.style.setProperty(
		'--login-page-background-color',
		PALETTE_BACKGROUNDS[sbGlobals.palette][sbGlobals.scheme]
	);
	root.lang = sbGlobals.locale;
	root.dir = toDocumentDirection(sbGlobals.locale);
}

// Docs pages without stories run no decorator, so follow the globals from the channel as well.
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

/** Pick the control by the number of choices, for every component at once. */
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
		template: {
			description: "Login UI template: the structure of the page (the Admin console's Themes page)",
			toolbar: {
				title: 'Template',
				icon: 'layout',
				items: TEMPLATES.map((value) => ({ value, title: TEMPLATE_LABELS[value] })),
				dynamicTitle: true
			}
		},
		palette: {
			description: 'Login UI palette: the colours and the shape of the form area',
			toolbar: {
				title: 'Palette',
				icon: 'paintbrush',
				items: PALETTES.map((value) => ({ value, title: PALETTE_LABELS[value] })),
				dynamicTitle: true
			}
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
		locale: {
			description: 'Language (ar switches to right-to-left)',
			toolbar: {
				title: 'Language',
				icon: 'globe',
				items: LOGIN_UI_LOCALES.map((value) => ({
					value,
					title: `${value} ${LOGIN_UI_LOCALE_LABELS[value]}`
				})),
				dynamicTitle: true
			}
		}
	},
	initialGlobals: { template: 'standard', palette: 'meridian', scheme: 'light', locale: 'ja' },
	// Globals are applied before the story renders: state cannot change during Svelte's render phase.
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
					'Foundations',
					['Themes', 'Page options', 'Icons'],
					'Catalog',
					['Buttons', 'Links', 'Text', 'Forms', 'Feedback'],
					'Components',
					'Runtime screen',
					'Page shell',
					'Account',
					'Screens'
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
