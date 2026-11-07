import { describe, expect, it, vi } from 'vitest';
import { newThemeDraft, type ThemeDraft } from './theme-draft';
import { draftToValues, openStored, uploadThemeImages, valuesToDraft } from './theme-values';

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
		expect(draft.palette).toBe('meridian');
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
		const values = draftToValues(valuesToDraft({}), openStored({}));
		expect(values).toEqual({});
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
		const upload = vi.fn(async (kind: string) => `/api/assets/acme/login-ui/${kind}/x.png`);
		const draft = await uploadThemeImages(
			{ ...newThemeDraft(), backgroundImage: file, logo: 'https://cdn.example.test/logo.png' },
			upload
		);
		expect(upload).toHaveBeenCalledExactlyOnceWith('background', file);
		expect(draft.backgroundImage).toBe('/api/assets/acme/login-ui/background/x.png');
		expect(draft.logo).toBe('https://cdn.example.test/logo.png');
	});
});
