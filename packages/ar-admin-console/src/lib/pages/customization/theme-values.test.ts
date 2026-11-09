import { describe, expect, it, vi } from 'vitest';
import { newThemeDraft, type ThemeDraft } from './theme-draft';
import {
	draftToValues,
	needsResave,
	openStored,
	uploadThemeImages,
	valuesToDraft
} from './theme-values';

function edited(): ThemeDraft {
	const draft = newThemeDraft();
	return {
		...draft,
		template: 'split',
		palette: 'clear-glass',
		accent: '#284f97',
		cardColor: '#ffffff1a',
		font: 'rounded',
		fontScale: 'spacious',
		mode: 'dark',
		topbarPosition: 'form_bottom_center',
		header: false,
		languageSelect: false,
		brandName: 'Acme',
		headerName: 'Acme ID',
		logoDisplay: 'logo',
		brandLogoDisplay: 'name',
		panelTitle: 'Welcome',
		panelText: 'One account',
		splitFrame: 'card',
		splitSide: 'right',
		formFrame: 'card',
		splitWidth: 'wide',
		brandPosition: 'top',
		brandAlign: 'center',
		texts: {
			...draft.texts,
			ja: { tagline: 'ようこそ', footer: '' },
			en: { tagline: 'Welcome', footer: 'Footer' }
		},
		logo: 'https://cdn.example.test/logo.png',
		backgroundOpacity: 40,
		customCss: '.card { color: red; }'
	};
}

describe('theme values', () => {
	it('saves the whole look under the settings’ keys and names', () => {
		const values = draftToValues(edited());
		expect(values).toMatchObject({
			'login-ui.template': 'split',
			'login-ui.palette': 'clear-glass',
			'login-ui.theme': 'dark',
			'login-ui.accent_color': '#284f97',
			'login-ui.form_area_color': '#ffffff1a',
			'login-ui.header_enabled': false,
			// The screens name the logo display differently.
			'login-ui.logo_display': 'image',
			'login-ui.brand_panel_logo_display': 'text',
			'login-ui.brand_content_mode': 'logo_copy',
			'login-ui.split_panel_side': 'right',
			'login-ui.logo_url': 'https://cdn.example.test/logo.png',
			'login-ui.background_image_opacity': 40
		});
		// Colours and images left empty are not written: the template's own apply.
		expect(values).not.toHaveProperty('login-ui.background_color');
		expect(values).not.toHaveProperty('login-ui.favicon_url');
		// Texts per language; an empty footer is kept (it hides the default footer).
		expect(JSON.parse(values['login-ui.text_localizations'] as string)).toMatchObject({
			ja: { tagline: 'ようこそ', footerText: '' },
			en: { tagline: 'Welcome', footerText: 'Footer' }
		});
	});

	it('opens a saved theme as the draft it was saved from', () => {
		const draft = edited();
		expect(valuesToDraft(draftToValues(draft))).toEqual({ ...draft, language: 'en' });
		expect(valuesToDraft(draftToValues(newThemeDraft()))).toEqual(newThemeDraft());
	});

	it('keeps each dark image explicitly unset when the light mode has an image', () => {
		const draft = {
			...newThemeDraft(),
			logo: 'https://cdn.example.test/light-logo.png',
			backgroundImage: 'https://cdn.example.test/light-bg.png',
			cardImage: 'https://cdn.example.test/light-form.png',
			darkImages: {
				logo: null,
				backgroundImage: 'https://cdn.example.test/dark-bg.png',
				cardImage: null
			}
		};
		const values = draftToValues(draft);
		expect(JSON.parse(values['login-ui.dark_images'] as string)).toEqual({
			logo: '',
			background: 'https://cdn.example.test/dark-bg.png',
			form_area: ''
		});
		expect(valuesToDraft(values)).toEqual(draft);
	});

	it('opens older themes with their light images in both modes and writes that choice on save', () => {
		const old = {
			'login-ui.logo_url': 'https://cdn.example.test/logo.png',
			'login-ui.background_image_url': 'https://cdn.example.test/bg.png',
			'login-ui.login_panel_background_image_url': 'https://cdn.example.test/form.png'
		};
		const opened = openStored(old);
		expect(opened.opened.darkImages).toEqual({
			logo: old['login-ui.logo_url'],
			backgroundImage: old['login-ui.background_image_url'],
			cardImage: old['login-ui.login_panel_background_image_url']
		});
		expect(
			JSON.parse(draftToValues(opened.opened, opened)['login-ui.dark_images'] as string)
		).toEqual({
			logo: old['login-ui.logo_url'],
			background: old['login-ui.background_image_url'],
			form_area: old['login-ui.login_panel_background_image_url']
		});
	});

	it('saves the background image filters in order and opens them again', () => {
		const draft: ThemeDraft = {
			...newThemeDraft(),
			backgroundFilters: [
				{ name: 'hue-rotate', value: 200 },
				{ name: 'blur', value: 4 }
			]
		};
		const values = draftToValues(draft);
		expect(values['login-ui.background_image_filters']).toBe('hue-rotate:200;blur:4');
		expect(valuesToDraft(values).backgroundFilters).toEqual(draft.backgroundFilters);
		// None is written as an empty value, which clears filters a theme had.
		expect(draftToValues(newThemeDraft())['login-ui.background_image_filters']).toBe('');
		// A stored value the editor does not know reads as no filters, or only its valid ones.
		expect(
			valuesToDraft({ 'login-ui.background_image_filters': 'blur:99;sepia:30;nope:1' })
				.backgroundFilters
		).toEqual([{ name: 'sepia', value: 30 }]);
	});

	it('opens the older grayscale switch as a grayscale filter, and saves it as one', () => {
		const stored = openStored({
			'login-ui.background_image_grayscale': true,
			'login-ui.background_image_filters': 'blur:2'
		});
		expect(stored.opened.backgroundFilters).toEqual([
			{ name: 'grayscale', value: 100 },
			{ name: 'blur', value: 2 }
		]);
		// Not changed: kept as stored, the switch included.
		const kept = draftToValues(valuesToDraft(stored.values), stored);
		expect(kept['login-ui.background_image_grayscale']).toBe(true);
		expect(kept['login-ui.background_image_filters']).toBe('blur:2');
		// Changed: the filters carry the grayscale, and the switch is turned off.
		const draft = valuesToDraft(stored.values);
		draft.backgroundFilters[0].value = 40;
		const changed = draftToValues(draft, stored);
		expect(changed['login-ui.background_image_filters']).toBe('grayscale:40;blur:2');
		expect(changed['login-ui.background_image_grayscale']).toBe(false);
	});

	it('saves the input field and secondary button colours', () => {
		const draft = { ...newThemeDraft(), fieldColor: '#fafafa', secondaryButtonColor: '#12345680' };
		const values = draftToValues(draft);
		expect(values['login-ui.field_color']).toBe('#fafafa');
		expect(values['login-ui.secondary_button_color']).toBe('#12345680');
		expect(valuesToDraft(values)).toMatchObject({
			fieldColor: '#fafafa',
			secondaryButtonColor: '#12345680'
		});
		// Empty is not written: the palette's own colours apply.
		expect(draftToValues(newThemeDraft())).not.toHaveProperty('login-ui.field_color');
	});

	it('saves the bars, links and dark-mode colours, and opens them again', () => {
		const draft = {
			...newThemeDraft(),
			linkColor: '#1a73e8',
			brandPanelBackground: '#090d1e61',
			themeToggleBackground: '#111111',
			languageSelectBackground: '#f0f0f0',
			headerBackground: '#ffffffcc',
			headerText: '#101010',
			footerBackground: '#000000',
			footerText: '#eeeeee',
			headerAlign: 'center' as const,
			footerAlign: 'right' as const,
			topbarPosition: 'header_right' as const,
			darkColours: {
				accent: '#93aef2',
				brand_panel_background: '#01020380',
				theme_toggle_background: '#eeeeee',
				language_select_background: '#222222',
				header_background: '#0b0e16'
			}
		};
		const values = draftToValues(draft);
		expect(values).toMatchObject({
			'login-ui.link_color': '#1a73e8',
			'login-ui.brand_panel_background_color': '#090d1e61',
			'login-ui.theme_toggle_background_color': '#111111',
			'login-ui.language_select_background_color': '#f0f0f0',
			'login-ui.header_background_color': '#ffffffcc',
			'login-ui.header_text_color': '#101010',
			'login-ui.footer_background_color': '#000000',
			'login-ui.footer_text_color': '#eeeeee',
			'login-ui.header_align': 'center',
			'login-ui.footer_align': 'right',
			'login-ui.topbar_position': 'header_right',
			'login-ui.header_style': 'bar',
			'login-ui.footer_style': 'bar',
			'login-ui.dark_colors':
				'{"brand_panel_background":"#01020380","accent":"#93aef2","theme_toggle_background":"#eeeeee","language_select_background":"#222222","header_background":"#0b0e16"}'
		});
		expect(valuesToDraft(values)).toMatchObject({
			linkColor: '#1a73e8',
			brandPanelBackground: '#090d1e61',
			themeToggleBackground: '#111111',
			languageSelectBackground: '#f0f0f0',
			headerAlign: 'center',
			footerAlign: 'right',
			topbarPosition: 'header_right',
			darkColours: {
				brand_panel_background: '#01020380',
				accent: '#93aef2',
				theme_toggle_background: '#eeeeee',
				language_select_background: '#222222',
				header_background: '#0b0e16'
			}
		});
		// No dark colour set: written empty (the theme has a dark set, the palette's).
		expect(draftToValues(newThemeDraft())['login-ui.dark_colors']).toBe('');
	});

	it('opens the new colours as the screens read them, dropping what they would not apply', () => {
		const draft = valuesToDraft({
			'login-ui.link_color': 'rgb(100%, 0%, 0%)',
			'login-ui.header_background_color': '#1f2a44',
			'login-ui.brand_panel_background_color': 'url(x)',
			'login-ui.theme_toggle_background_color': 'red',
			'login-ui.language_select_background_color': '#ffffff',
			'login-ui.title_color': 'red'
		});
		expect(draft.linkColor).toBe('');
		expect(draft.headerBackground).toBe('#1f2a44');
		expect(draft.brandPanelBackground).toBe('');
		expect(draft.themeToggleBackground).toBe('');
		expect(draft.languageSelectBackground).toBe('#ffffff');
		// The older colours keep their wider rule.
		expect(draft.titleColor).toBe('red');
	});

	it('takes over the colours of a dark theme saved before dark colours had a set of their own', () => {
		const stored = openStored({
			'login-ui.theme': 'dark',
			'login-ui.background_color': '#101820',
			'login-ui.accent_color': '#ff8800',
			'login-ui.title_color': 'white'
		});
		// Opened as an explicit dark set, in the form the dark set takes (the named colour left out)...
		expect(stored.opened.darkColours).toEqual({ background: '#101820', accent: '#ff8800' });
		// ...which saving writes, unchanged too: the preview shows what is saved.
		expect(draftToValues(stored.opened, stored)['login-ui.dark_colors']).toBe(
			'{"background":"#101820","accent":"#ff8800"}'
		);
		// A light colour changed afterwards stays light: the dark set is the theme's own now.
		const changed = { ...stored.opened, background: '#ffffff' };
		expect(draftToValues(changed, stored)['login-ui.dark_colors']).toBe(
			'{"background":"#101820","accent":"#ff8800"}'
		);
		// A theme that has dark colours, or follows the device, is read as it is.
		expect(
			valuesToDraft({
				'login-ui.theme': 'dark',
				'login-ui.dark_colors': '',
				'login-ui.accent_color': '#ff8800'
			}).darkColours
		).toEqual({});
		expect(
			valuesToDraft({ 'login-ui.theme': 'auto', 'login-ui.accent_color': '#ff8800' }).darkColours
		).toEqual({});
	});

	it('tells a stored theme that would be saved differently from one that would not', () => {
		// Saved before the bars: saving it changes it.
		expect(needsResave(openStored({ 'login-ui.palette': 'glass' }))).toBe(true);
		// Saved by this editor: saving it again changes nothing.
		const saved = draftToValues(newThemeDraft());
		expect(needsResave(openStored(saved))).toBe(false);
	});

	it('writes the header and footer as bars over a stored theme that said otherwise', () => {
		const stored = openStored({
			'login-ui.header_style': 'center',
			'login-ui.footer_style': 'simple'
		});
		const values = draftToValues(stored.opened, stored);
		expect(values['login-ui.header_style']).toBe('bar');
		expect(values['login-ui.footer_style']).toBe('bar');
	});

	it('shows nothing of the brand on the panel as brand_content_mode none', () => {
		const values = draftToValues({ ...newThemeDraft(), brandLogoDisplay: 'none' });
		expect(values['login-ui.brand_content_mode']).toBe('none');
		expect(values).not.toHaveProperty('login-ui.brand_panel_logo_display');
		expect(valuesToDraft(values).brandLogoDisplay).toBe('none');
	});

	it('falls back to the editor’s default for a value it does not know', () => {
		const draft = valuesToDraft({
			'login-ui.template': 'unknown',
			'login-ui.palette': 42,
			'login-ui.background_image_opacity': 250,
			'login-ui.text_localizations': '{not json',
			'login-ui.brand_panel_logo_display': 'inherit',
			'login-ui.logo_display': 'text'
		});
		expect(draft.template).toBe('standard');
		expect(draft.palette).toBe('clean');
		expect(draft.backgroundOpacity).toBe(100);
		// The panel follows the header when it inherits.
		expect(draft.brandLogoDisplay).toBe('name');
	});

	it('keeps, over a stored theme, what the editor does not edit', () => {
		const stored = {
			'login-ui.template': 'split',
			'login-ui.subtitle_enabled': false,
			'login-ui.footer_links': '[{"label":"Help","url":"https://help.example.test"}]',
			'login-ui.logo_display': 'hidden',
			'login-ui.brand_content_mode': 'logo_copy',
			'login-ui.brand_panel_logo_display': 'hidden',
			'login-ui.text_localizations': JSON.stringify({
				en: { tagline: 'Hello', loginTitle: 'Sign in to Acme' },
				fr: { tagline: 'Bonjour' }
			})
		};
		// Opened and saved again as it was: every value is as stored.
		const again = draftToValues(valuesToDraft(stored), openStored(stored));
		for (const [key, value] of Object.entries(stored)) {
			if (key === 'login-ui.text_localizations') continue;
			expect(again[key], key).toEqual(value);
		}
		const texts = JSON.parse(String(again['login-ui.text_localizations']));
		expect(texts.en).toMatchObject({ tagline: 'Hello', loginTitle: 'Sign in to Acme' });
		expect(texts.fr).toEqual({ tagline: 'Bonjour' });

		// What the admin changes is written: the header shows the logo, the panel shows the name.
		const changed = draftToValues(
			{ ...valuesToDraft(stored), logoDisplay: 'logo', brandLogoDisplay: 'name' },
			openStored(stored)
		);
		expect(changed['login-ui.logo_display']).toBe('image');
		expect(changed['login-ui.brand_panel_logo_display']).toBe('text');
		expect(changed['login-ui.subtitle_enabled']).toBe(false);
	});

	it('keeps a text that is empty, or not set, while it is not changed', () => {
		const stored = {
			'login-ui.header_text': 'Welcome',
			'login-ui.footer_text': '© Acme',
			'login-ui.text_localizations': JSON.stringify({ en: { tagline: '' } })
		};
		const again = draftToValues(valuesToDraft(stored), openStored(stored));
		expect(again['login-ui.text_localizations']).toBe(stored['login-ui.text_localizations']);
		expect(again['login-ui.footer_text']).toBe('© Acme');

		// One text changed: only that one is written; the others stay as they were.
		const draft = valuesToDraft(stored);
		draft.texts.ja.tagline = 'ようこそ';
		const texts = JSON.parse(
			String(draftToValues(draft, openStored(stored))['login-ui.text_localizations'])
		);
		expect(texts.en).toEqual({ tagline: '' });
		expect(texts.ja).toEqual({ tagline: 'ようこそ' });
	});

	it('keeps a panel that follows the header while the panel is not changed', () => {
		const stored = {
			'login-ui.logo_display': 'image',
			'login-ui.brand_panel_logo_display': 'inherit'
		};
		const draft = { ...valuesToDraft(stored), logoDisplay: 'name' as const };
		const values = draftToValues(draft, openStored(stored));
		expect(values['login-ui.logo_display']).toBe('text');
		expect(values['login-ui.brand_panel_logo_display']).toBe('inherit');
		expect(values).not.toHaveProperty(['login-ui.brand_content_mode']);
	});

	it('keeps a panel that follows the header through a second save', () => {
		const stored = {
			'login-ui.logo_display': 'image',
			'login-ui.brand_panel_logo_display': 'inherit'
		};
		const draft = { ...valuesToDraft(stored), logoDisplay: 'name' as const };
		const first = draftToValues(draft, openStored(stored));
		// Saved: the page keeps the draft it saved as what the theme was opened as.
		const again = { ...draft, accent: '#123456' };
		const second = draftToValues(again, { values: first, opened: draft });
		expect(second['login-ui.brand_panel_logo_display']).toBe('inherit');
		expect(second['login-ui.accent_color']).toBe('#123456');
	});

	it('keeps a stored theme with no values as it is, not as a new one', () => {
		// Only what the editor always draws is written: the header and footer as bars, and a dark
		// set (empty: the palette's) and an explicitly empty dark image set.
		const values = draftToValues(valuesToDraft({}), openStored({}));
		expect(values).toEqual({
			'login-ui.header_style': 'bar',
			'login-ui.footer_style': 'bar',
			'login-ui.dark_colors': '',
			'login-ui.dark_images': '{"logo":"","background":"","form_area":""}'
		});
	});

	it('keeps a panel that shows the logo alone', () => {
		const stored = {
			'login-ui.brand_content_mode': 'logo',
			'login-ui.brand_panel_logo_display': 'image'
		};
		const again = draftToValues(valuesToDraft(stored), openStored(stored));
		expect(again['login-ui.brand_content_mode']).toBe('logo');
	});

	it('uploads chosen files and keeps stored URLs', async () => {
		const file = new File(['x'], 'bg.png', { type: 'image/png' });
		const darkFile = new File(['y'], 'dark-form.png', { type: 'image/png' });
		const upload = vi.fn(async (kind: string) => `/api/assets/acme/login-ui/${kind}/x.png`);
		const draft = await uploadThemeImages(
			{
				...newThemeDraft(),
				backgroundImage: file,
				logo: 'https://cdn.example.test/logo.png',
				darkImages: { logo: null, backgroundImage: null, cardImage: darkFile }
			},
			upload
		);
		expect(upload).toHaveBeenNthCalledWith(1, 'background', file);
		expect(upload).toHaveBeenNthCalledWith(2, 'panel-background', darkFile);
		expect(draft.backgroundImage).toBe('/api/assets/acme/login-ui/background/x.png');
		expect(draft.darkImages.cardImage).toBe('/api/assets/acme/login-ui/panel-background/x.png');
		expect(draft.logo).toBe('https://cdn.example.test/logo.png');
	});
});
