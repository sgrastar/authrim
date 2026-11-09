<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import { schemaChoices } from '#lib/ui/stories/screen-parts.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import ThemeEditor from './ThemeEditor.svelte';
	import type { BgPreset } from './bg-presets';
	import { newThemeDraft } from './theme-draft';

	// The presets the setup tool installs, read from where they live in the repository (the
	// Admin API lists them from the public assets in a real console).
	const PRESET_FILES = import.meta.glob<string>(
		'../../../../../ar-management/assets/login-ui-presets/backgrounds/*/*.webp',
		{ eager: true, query: '?url', import: 'default' }
	);
	const PAPER_PRESET =
		Object.values(PRESET_FILES).find((url) => url.includes('indigo-washi')) ?? null;
	const FOREST_PRESET =
		Object.values(PRESET_FILES).find((url) => url.includes('misty-japanese-forest-deer')) ?? null;
	const storyPresets = async (): Promise<BgPreset[]> =>
		Object.entries(PRESET_FILES).flatMap(([path, url]) => {
			const match = /\/backgrounds\/([^/]+)\/([^/]+)\.webp$/.exec(path);
			return match
				? [{ id: `${match[1]}/${match[2]}`, category: match[1], name: match[2], url }]
				: [];
		});
	const STORY_SCREENS = [
		...MOCK_SCREENS,
		{
			...MOCK_SCREENS[0],
			id: 'screen_login_copy',
			screen_key: 'login_custom',
			display_name: 'Login copy',
			is_system: false
		},
		{
			...MOCK_SCREENS[3],
			id: 'screen_profile_copy',
			screen_key: 'profile_completion_custom',
			display_name: 'Profile completion copy',
			is_system: false
		}
	];
	const { Story } = defineMeta({
		title: 'Pages/Customization/Theme editor',
		component: ThemeEditor,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Themes → a theme: how the tenant’s sign-in screens look. The theme page (`ThemeEditorPage`) puts this editor under its header (the theme’s name, Save, Apply) and loads and saves the draft through `/api/admin/login-ui/themes`.\n\nThe preview on the start side (screen, colour mode, phone or desktop width), the inspector on the end side (one tab per section: Layout, Design, Content, Images), and custom CSS under both, set a size down because it is narrow and holds many controls. What is edited is drawn in the preview as it is typed, chosen or uploaded; custom CSS is not applied in the preview. The console picker shows saved registration, login, and profile completion screens in that order; if none are saved, it shows system screens of those kinds. Standalone stories without a screens client retain the sample outline.'
				}
			}
		}
	});
</script>

<Story
	name="Frame"
	play={async ({ canvasElement }) => {
		const preview = canvasElement.querySelector('.workspace__preview') as HTMLElement;
		const inspector = canvasElement.querySelector('.workspace__edit') as HTMLElement;
		// Side by side (wider than the stacking breakpoint), the preview comes first and the
		// inspector after it; on a narrow screen they stack and the order is editing first.
		if (matchMedia('(min-width: 901px)').matches) {
			await expect(preview.getBoundingClientRect().left).toBeLessThan(
				inspector.getBoundingClientRect().left
			);
		}
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Saved screen parts"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const picker = await canvas.findByRole('combobox', { name: t('th.preview.screen') });
		await waitFor(() =>
			expect([...(picker as HTMLSelectElement).options].map((option) => option.value)).toEqual([
				'screen_signup',
				'screen_login_copy',
				'screen_profile_copy'
			])
		);
		await expect(picker).toHaveValue('screen_signup');
		await userEvent.selectOptions(picker, 'screen_signup');
		await waitFor(() => expect(canvas.getByText('Create your account')).toBeVisible());
		await expect(canvas.getByText(/Given name/)).toBeVisible();
		await userEvent.selectOptions(picker, 'screen_login_copy');
		await waitFor(() => expect(canvas.getByText('Sign in with Passkey')).toBeVisible());
		await userEvent.selectOptions(picker, 'screen_profile_copy');
		await waitFor(() => expect(canvas.getByText('Preferred username')).toBeVisible());
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				screensClient={createFakeScreens({ screens: STORY_SCREENS })}
				choices={schemaChoices}
			/>
		</Page>
	{/snippet}
</Story>

<Story
	name="System screens when none is saved"
	play={async ({ canvasElement }) => {
		const picker = await within(canvasElement).findByRole('combobox', {
			name: t('th.preview.screen')
		});
		await waitFor(() =>
			expect([...(picker as HTMLSelectElement).options].map((option) => option.value)).toEqual([
				'screen_login',
				'screen_profile'
			])
		);
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				screensClient={createFakeScreens({
					screens: MOCK_SCREENS.filter((screen) => screen.is_system)
				})}
			/>
		</Page>
	{/snippet}
</Story>

<Story
	name="Topbar control colours choose readable ink"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const toggle = canvasElement.querySelector('.tools__item--icon') as HTMLElement;
		const language = canvasElement.querySelector('.tools__item--language') as HTMLElement;
		await expect(getComputedStyle(toggle).backgroundColor).toBe('rgb(17, 17, 17)');
		await expect(getComputedStyle(toggle).color).toBe('rgb(255, 255, 255)');
		await expect(getComputedStyle(language).backgroundColor).toBe('rgb(238, 238, 238)');
		await expect(getComputedStyle(language).color).toBe('rgb(0, 0, 0)');
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await expect(
			canvas.getByRole('textbox', { name: t('th.c.themeToggleBackground') })
		).toHaveValue('#111111');
		await expect(
			canvas.getByRole('textbox', { name: t('th.c.languageSelectBackground') })
		).toHaveValue('#eeeeee');
		await userEvent.click(canvas.getByRole('tab', { name: t('th.mode.dark') }));
		await waitFor(() => expect(getComputedStyle(toggle).color).toBe('rgb(0, 0, 0)'));
		await expect(getComputedStyle(language).color).toBe('rgb(255, 255, 255)');
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				draft={{
					...newThemeDraft(),
					themeToggleBackground: '#111111',
					languageSelectBackground: '#eeeeee',
					darkColours: {
						theme_toggle_background: '#f5f5f5',
						language_select_background: '#222222'
					}
				}}
			/>
		</Page>
	{/snippet}
</Story>

<!-- Split over a background image: the brand side is see-through, as on the real screen (the
     accent fill would hide the picture). -->
<Story
	name="Split over a background image"
	play={async ({ canvasElement }) => {
		await waitFor(() =>
			expect(canvasElement.querySelector('.outline__panel')).toHaveClass(
				'outline__panel--over-image'
			)
		);
		const panel = canvasElement.querySelector('.outline__panel') as HTMLElement;
		await expect(getComputedStyle(panel, '::before').backgroundColor).toContain('0.38');
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				draft={{
					...newThemeDraft(),
					template: 'split',
					palette: 'clear-glass',
					formFrame: 'card',
					backgroundImage: FOREST_PRESET
				}}
			/>
		</Page>
	{/snippet}
</Story>

<Story
	name="Split brand area background is editable"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await expect(
			canvas.queryByRole('textbox', { name: t('th.c.brandPanelBackground') })
		).toBeNull();
		await userEvent.click(canvas.getByRole('tab', { name: t('th.tab.layout') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(canvas.getByRole('tab', { name: t('th.tab.look') }));
		const field = await canvas.findByRole('textbox', { name: t('th.c.brandPanelBackground') });
		await expect(field).toHaveAttribute('placeholder', '#090d1e61');
		await userEvent.type(field, '#112233');
		fireEvent.input(
			canvas.getByRole('slider', {
				name: t('color.opacity', { name: t('th.c.brandPanelBackground') })
			}),
			{ target: { value: '40' } }
		);
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		const panel = canvasElement.querySelector('.outline__panel') as HTMLElement;
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-brand-bg')).toBe('#11223366'));
		await expect(getComputedStyle(panel, '::before').backgroundColor).toContain('17, 34, 51');
		await userEvent.click(canvas.getByRole('tab', { name: t('th.mode.dark') }));
		const darkField = await canvas.findByRole('textbox', { name: t('th.c.brandPanelBackground') });
		await userEvent.type(darkField, '#445566');
		fireEvent.input(
			canvas.getByRole('slider', {
				name: t('color.opacity', { name: t('th.c.brandPanelBackground') })
			}),
			{ target: { value: '50' } }
		);
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-brand-bg')).toBe('#44556680'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<!-- Filters on the background image: the "⋯" beside the folder adds one, each gets a slider under
     the opacity, and the bin removes it. The preview draws them in order. -->
<Story
	name="Header and footer bars"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const outline = () => canvasElement.querySelector('.outline') as HTMLElement;
		// The brand in the middle of the header; the footer's text at the end.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.headerAlign') }),
			'center'
		);
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.footerAlign') }),
			'right'
		);
		await waitFor(() =>
			expect(
				outline().querySelector('.outline__header .outline__zone--center .brand')
			).not.toBeNull()
		);
		await expect(
			outline().querySelector('.outline__footer .outline__zone--right .outline__footer-text')
		).not.toBeNull();
		// The colour-mode and language choices in the header, on its end side.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.topbar') }),
			'header_right'
		);
		await waitFor(() =>
			expect(
				outline().querySelector('.outline__header .outline__zone--right .tools')
			).not.toBeNull()
		);
		// The bars take their own colours.
		await userEvent.type(
			await canvas.findByRole('textbox', { name: t('th.c.headerBackground') }),
			'#1f2a44'
		);
		await userEvent.type(
			await canvas.findByRole('textbox', { name: t('th.c.headerText') }),
			'#ffffff'
		);
		await waitFor(() => expect(outline().style.getPropertyValue('--ol-header-bg')).toBe('#1f2a44'));
		await expect(outline().style.getPropertyValue('--ol-header-text')).toBe('#ffffff');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Theme definition shows what saving writes"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByText(t('th.def.title')));
		const field = await canvas.findByRole('textbox', { name: t('th.def.field') });
		const definition = () => JSON.parse((field as HTMLTextAreaElement).value);
		await expect(definition()).toMatchObject({
			'login-ui.header_style': 'bar',
			'login-ui.footer_style': 'bar',
			'login-ui.palette': 'clean'
		});
		// It follows the edits.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.type(await canvas.findByRole('textbox', { name: t('th.c.link') }), '#1a73e8');
		await waitFor(() => expect(definition()['login-ui.link_color']).toBe('#1a73e8'));
		// The tab turned over: read once it has settled (the checks after the story read colours).
		await waitFor(() =>
			expect(
				document.getAnimations().filter((animation) => animation.playState === 'running')
			).toHaveLength(0)
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Background image filters"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const layer = () => canvasElement.querySelector<HTMLElement>('.outline > .outline__image');
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// No picture, nothing to filter: the menu waits for one.
		await expect(canvas.getByRole('button', { name: t('th.f.add') })).toBeDisabled();
		// Logo, background: the second.
		const [, background] = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(background, new File(['x'], 'bg.png', { type: 'image/png' }));
		await waitFor(() => expect(layer()).not.toBeNull());
		const add = async (name: string) => {
			await userEvent.click(canvas.getByRole('button', { name: t('th.f.add') }));
			await userEvent.click(await body.findByRole('menuitem', { name }));
		};
		await add(t('th.f.hue-rotate'));
		const hue = await canvas.findByRole('slider', { name: t('th.f.hue-rotate') });
		fireEvent.input(hue, { target: { value: '200' } });
		await waitFor(() => expect(layer()?.style.filter).toBe('hue-rotate(200deg)'));
		await add(t('th.f.blur'));
		await waitFor(() => expect(layer()?.style.filter).toBe('hue-rotate(200deg) blur(4px)'));
		// A filter already added is not offered again.
		await userEvent.click(canvas.getByRole('button', { name: t('th.f.add') }));
		await expect(await body.findByRole('menuitem', { name: t('th.f.blur') })).toBeDisabled();
		await userEvent.keyboard('{Escape}');
		await userEvent.click(
			canvas.getByRole('button', { name: t('th.f.remove', { name: t('th.f.hue-rotate') }) })
		);
		await waitFor(() => expect(layer()?.style.filter).toBe('blur(4px)'));
		await expect(canvas.queryByRole('slider', { name: t('th.f.hue-rotate') })).toBeNull();
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor presets={storyPresets} />
		</Page>
	{/snippet}
</Story>

<Story
	name="Background presets"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('tab', { name: t('th.tab.images') }));
		await userEvent.click(canvas.getAllByRole('button', { name: t('th.bg.browse') })[0]);
		const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
		await waitFor(() => expect(within(dialog).getAllByRole('button').length).toBeGreaterThan(5));
		// The picture in use is a paper preset: its category opens, not the first one.
		await waitFor(() =>
			expect(
				within(dialog).getByRole('button', { name: new RegExp(`^${t('th.bg.cat.paper')}`) })
			).toHaveAttribute('aria-pressed', 'true')
		);
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				presets={storyPresets}
				draft={{ ...newThemeDraft(), backgroundImage: PAPER_PRESET }}
			/>
		</Page>
	{/snippet}
</Story>

<Story
	name="Images are independent in light and dark modes"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const image = () => canvasElement.querySelector('.outline > .outline__image');
		const formImage = () => canvasElement.querySelector('.outline__card .outline__image');
		const logo = () => canvasElement.querySelector('.outline .brand__logo[src]');
		const svg = (name: string, first: string, last: string) =>
			new File(
				[
					`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${first}"/><stop offset="1" stop-color="${last}"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/></svg>`
				],
				name,
				{ type: 'image/svg+xml' }
			);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		const lightFiles = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(lightFiles[0], svg('logo.svg', '#f1c27d', '#cc8150'));
		await userEvent.upload(lightFiles[1], svg('background.svg', '#e2f3d9', '#9bc7c2'));
		await userEvent.upload(lightFiles[2], svg('form.svg', '#fdf4db', '#e5c5a1'));
		await waitFor(() => expect(image()).not.toBeNull());
		await expect(formImage()).not.toBeNull();
		await expect(logo()).not.toBeNull();
		await userEvent.click(canvas.getByRole('tab', { name: t('th.mode.dark') }));
		await waitFor(() => expect(image()).toBeNull());
		await expect(formImage()).toBeNull();
		await expect(logo()).toBeNull();
		// A dark image can be chosen without filling the other two dark slots.
		const darkBackground =
			canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
		await userEvent.upload(darkBackground, svg('dark-background.svg', '#193c45', '#0d1f34'));
		await waitFor(() => expect(image()).not.toBeNull());
		await expect(formImage()).toBeNull();
		await expect(logo()).toBeNull();
		await userEvent.click(canvas.getByRole('tab', { name: t('th.mode.light') }));
		await waitFor(() => expect(formImage()).not.toBeNull());
		await expect(logo()).not.toBeNull();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Phone width"
	parameters={{ viewport: { defaultViewport: 'mobile1' } }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Stacked: editing first, the preview after it.
		await canvas.findByRole('tab', { name: t('th.tab.look') });
		await canvas.findByRole('heading', { name: t('th.preview.title') });
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Switch section"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// In the document, not "visible": the page fades in when it is entered.
		await expect(
			await canvas.findByRole('heading', { name: t('th.g.favicon') })
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Reset the colours to the palette's"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const reset = await canvas.findByRole('button', { name: t('th.c.reset') });
		// Nothing to reset while the palette's colours are in use.
		await expect(reset).toBeDisabled();
		const picker = canvas.getByLabelText(t('color.pick', { name: t('th.c.accent') }));
		await fireEvent.input(picker, { target: { value: '#ff0000' } });
		await waitFor(() => expect(reset).toBeEnabled());
		await userEvent.click(reset);
		await waitFor(() => expect(reset).toBeDisabled());
		// The field is empty again: it shows the palette's colour as its placeholder.
		const hex = canvasElement.querySelectorAll<HTMLInputElement>('.color__hex');
		for (const field of hex) await expect(field.value).toBe('');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="The header name is its own, apart from the brand name"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const headerName = () =>
			canvasElement.querySelector('.outline__header .brand__name')?.textContent;
		// The defaults: the header carries the header name, the footer the link to Authrim.
		await waitFor(() => expect(headerName()).toBe('Authrim'));
		await expect(canvasElement.querySelector('.outline__footer')?.textContent).toContain('Authrim');
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		// The brand name does not flow into the header.
		const brand = await canvas.findByRole('textbox', { name: t('th.f.brandName') });
		await userEvent.clear(brand);
		await userEvent.type(brand, 'Beta Ltd');
		await waitFor(() =>
			expect(canvasElement.querySelector('.outline__eyebrow')?.textContent?.trim()).toBe('Beta Ltd')
		);
		await expect(headerName()).toBe('Authrim');
		// The header name is changed on its own.
		const header = await canvas.findByRole('textbox', { name: t('th.f.headerName') });
		await userEvent.clear(header);
		await userEvent.type(header, 'Acme');
		await waitFor(() => expect(headerName()).toBe('Acme'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Brand panel settings are offered with Split only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await expect(canvas.queryByRole('textbox', { name: t('th.f.panelTitle') })).toBeNull();
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.layout') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		// The title starts with the default wording of the real screen.
		await expect(await canvas.findByRole('textbox', { name: t('th.f.panelTitle') })).toHaveValue(
			'Welcome to your account.'
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Custom CSS"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Custom CSS is not a tab: it sits under the preview and the inspector.
		const css = await canvas.findByRole('textbox', { name: t('th.f.css') });
		// "{{" types one "{" (user-event reads a single "{" as the start of a key such as {Enter}).
		await userEvent.type(css, '.card {{ border-radius: 0; }');
		await expect(css).toHaveValue('.card { border-radius: 0; }');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Typeface shows in the preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const font = await canvas.findByRole('combobox', { name: t('th.f.font') });
		await userEvent.selectOptions(font, 'serif');
		await expect(getComputedStyle(canvas.getByText(t('th.font.sample'))).fontFamily).toContain(
			'Georgia'
		);
		// The screen's title is set in it too, not in the console's heading face.
		const title = canvasElement.querySelector('.outline__card h3') as HTMLElement;
		await expect(getComputedStyle(title).fontFamily).toContain('Georgia');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Without the header"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.click(await canvas.findByLabelText(t('th.t.header')));
		const screen = canvasElement.querySelector('.outline') as HTMLElement;
		// The form's column: the card and what goes under it (the sign-up link, the choices).
		const card = canvasElement.querySelector('.outline__col') as HTMLElement;
		const middle = (box: DOMRect) => box.top + box.height / 2;
		// The form stays in the middle of the screen: the missing header does not move it.
		const offset = Math.abs(
			middle(card.getBoundingClientRect()) - middle(screen.getBoundingClientRect())
		);
		await expect(offset).toBeLessThan(screen.getBoundingClientRect().height * 0.1);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Colour and language choices follow the layout switches"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const tools = () => canvasElement.querySelectorAll('.tools__item');
		await waitFor(() => expect(tools()).toHaveLength(2));
		await userEvent.click(await canvas.findByLabelText(t('th.t.themeToggle')));
		await waitFor(() => expect(tools()).toHaveLength(1));
		await userEvent.click(await canvas.findByLabelText(t('th.t.language')));
		await waitFor(() => expect(tools()).toHaveLength(0));
		await userEvent.click(await canvas.findByLabelText(t('th.t.themeToggle')));
		await waitFor(() => expect(tools()).toHaveLength(1));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Colour fields show the colours in effect"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const background = await canvas.findByRole('textbox', { name: t('th.c.background') });
		const accent = await canvas.findByRole('textbox', { name: t('th.c.accent') });
		// Empty, but each shows the real screens' colour for the mode shown (light to begin with).
		await expect(background).toHaveValue('');
		await expect(background).toHaveAttribute('placeholder', '#eef1f6');
		await expect(accent).toHaveAttribute('placeholder', '#2f52c4');
		// Showing dark mode opens the dark colours: the fields show its colours, and set its own.
		await userEvent.click(await canvas.findByRole('radio', { name: t('th.mode.dark') }));
		await waitFor(() =>
			expect(canvas.getByRole('tab', { name: t('th.mode.dark') })).toHaveAttribute(
				'aria-selected',
				'true'
			)
		);
		const darkBackground = await canvas.findByRole('textbox', { name: t('th.c.background') });
		const darkAccent = await canvas.findByRole('textbox', { name: t('th.c.accent') });
		await waitFor(() => expect(darkBackground).toHaveAttribute('placeholder', '#0b0e16'));
		await expect(darkAccent).toHaveAttribute('placeholder', '#93aef2');
		// A colour of one's own replaces it, in the preview too.
		await userEvent.type(darkAccent, '#b4235a');
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-accent')).toBe('#b4235a'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Colours can be see-through, the accent cannot"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const title = await canvas.findByRole('textbox', { name: t('th.c.title') });
		await userEvent.type(title, '#b4235a');
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-title')).toBe('#b4235a'));
		// The opacity slider beside it: half see-through, in the preview too.
		const slider = await canvas.findByRole('slider', {
			name: t('color.opacity', { name: t('th.c.title') })
		});
		fireEvent.input(slider, { target: { value: '50' } });
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-title')).toBe('#b4235a80'));
		// The accent fills the buttons, whose label colour is picked against it: it stays solid.
		await expect(
			canvas.queryByRole('slider', { name: t('color.opacity', { name: t('th.c.accent') }) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Colour and language choices take the form area's colours"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.type(await canvas.findByRole('textbox', { name: t('th.c.card') }), '#123456');
		await userEvent.type(await canvas.findByRole('textbox', { name: t('th.c.text') }), '#fafafa');
		const item = canvasElement.querySelector('.tools__item') as HTMLElement;
		// Their background is the form area's and their text the body text: a pair set to be read.
		await waitFor(() => expect(getComputedStyle(item).backgroundColor).toBe('rgb(18, 52, 86)'));
		await expect(getComputedStyle(item.parentElement as HTMLElement).color).toBe(
			'rgb(250, 250, 250)'
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="The topbar inside the card stays above the card's picture"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const png = new File(['x'], 'card.png', { type: 'image/png' });
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		const files = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(files[2], png);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.topbar') }),
			'in_card'
		);
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		await waitFor(() => expect(card.querySelector(':scope > .tools')).not.toBeNull());
		// The picture comes first, so what the card holds paints over it.
		const children = [...card.children];
		await expect(children.indexOf(card.querySelector('.outline__image') as Element)).toBe(0);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Mode is auto, or fixed whatever the device uses"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const outline = () => canvasElement.querySelector('.outline') as HTMLElement;
		const mode = await canvas.findByRole('combobox', { name: t('th.f.mode') });
		// Auto (the default) follows the device the preview simulates.
		await expect(mode).toHaveValue('auto');
		await expect(outline().dataset.scheme).toBe('light');
		await userEvent.click(await canvas.findByRole('radio', { name: t('th.mode.dark') }));
		await waitFor(() => expect(outline().dataset.scheme).toBe('dark'));
		// Light fixes the design, although the simulated device is dark; the simulator is then off.
		await userEvent.selectOptions(mode, 'light');
		await waitFor(() => expect(outline().dataset.scheme).toBe('light'));
		await expect(await canvas.findByRole('radio', { name: t('th.mode.dark') })).toBeDisabled();
		await userEvent.selectOptions(mode, 'dark');
		await waitFor(() => expect(outline().dataset.scheme).toBe('dark'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Topbar position places the colour and language choices"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const topbar = () => canvas.findByRole('combobox', { name: t('th.f.topbar') });
		const place = async (value: string) => userEvent.selectOptions(await topbar(), value);
		const at = (selector: string) => canvasElement.querySelector(selector);
		// Below the card (the default), then inside it.
		await waitFor(() => expect(at('.outline__col > .tools')).not.toBeNull());
		await place('in_card');
		await waitFor(() => expect(at('.outline__card > .tools')).not.toBeNull());
		await expect(at('.outline__col > .tools')).toBeNull();
		// In the main area (between the header and the footer): its corner, then its bottom edge.
		await place('top_right');
		await waitFor(() => expect(at('.outline__stage > .outline__tools')).not.toBeNull());
		await place('bottom_center');
		await waitFor(() =>
			expect(at('.outline__stage > .outline__tools--bottom[data-at="center"]')).not.toBeNull()
		);
		await place('bottom_left');
		await waitFor(() =>
			expect(at('.outline__stage > .outline__tools--bottom[data-at="left"]')).not.toBeNull()
		);
		// "Form bottom" is Split's: not offered with Standard.
		await expect(
			within(await topbar()).queryByRole('option', { name: t('th.topbar.form_bottom_left') })
		).toBeNull();
		// Hidden: nowhere.
		await place('hidden');
		await waitFor(() => expect(canvasElement.querySelectorAll('.tools')).toHaveLength(0));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split can keep the topbar to the bottom of the form side"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const topbar = await canvas.findByRole('combobox', { name: t('th.f.topbar') });
		const box = (selector: string) =>
			(canvasElement.querySelector(selector) as HTMLElement).getBoundingClientRect();
		// Bottom right of the main area: under the brand panel's end too, at the stage's edge.
		await userEvent.selectOptions(topbar, 'bottom_right');
		await waitFor(() =>
			expect(
				canvasElement.querySelector('.outline__stage > .outline__tools--bottom')
			).not.toBeNull()
		);
		const wholeLeft = box('.outline__stage > .outline__tools--bottom').left;
		// Form bottom left: at the bottom of the form side alone, so right of the brand panel's edge.
		await userEvent.selectOptions(topbar, 'form_bottom_left');
		await waitFor(() =>
			expect(canvasElement.querySelector('.outline__main > .outline__tools--bottom')).not.toBeNull()
		);
		await expect(box('.outline__main > .outline__tools--bottom').left).toBeGreaterThanOrEqual(
			box('.outline__main').left - 1
		);
		await expect(box('.outline__main > .outline__tools--bottom').left).toBeLessThan(wholeLeft);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Font scale sets how roomy the form is"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const scale = await canvas.findByRole('combobox', { name: t('th.f.fontScale') });
		const padding = () =>
			parseFloat(
				getComputedStyle(canvasElement.querySelector('.outline__card') as HTMLElement).paddingTop
			);
		await expect(scale).toHaveValue('comfortable');
		const comfortable = padding();
		await userEvent.selectOptions(scale, 'compact');
		await waitFor(() => expect(padding()).toBeLessThan(comfortable));
		await userEvent.selectOptions(scale, 'spacious');
		await waitFor(() => expect(padding()).toBeGreaterThan(comfortable));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Form area has a colour of its own"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const colour = await canvas.findByRole('textbox', { name: t('th.c.card') });
		// Empty: the real screens' own (white in light), shown in the field.
		await expect(colour).toHaveAttribute('placeholder', '#ffffff');
		await userEvent.type(colour, '#ffeecc');
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		await waitFor(() => expect(getComputedStyle(card).backgroundColor).toBe('rgb(255, 238, 204)'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split full form area matches the live layout"
	play={async ({ canvasElement }) => {
		const main = canvasElement.querySelector('.outline__main') as HTMLElement;
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		const tools = canvasElement.querySelector('.outline__col > .tools') as HTMLElement;
		await expect(getComputedStyle(main).backgroundColor).toBe('rgba(17, 34, 51, 0.4)');
		await expect(getComputedStyle(main).backdropFilter).toBe('none');
		await expect(getComputedStyle(card).backgroundColor).toBe('rgba(0, 0, 0, 0)');
		await expect(card.getBoundingClientRect().height).toBeLessThan(
			main.getBoundingClientRect().height
		);
		await expect(
			tools.getBoundingClientRect().top - card.getBoundingClientRect().bottom
		).toBeLessThan(30);
	}}
>
	{#snippet template()}
		<Page>
			<ThemeEditor
				draft={{
					...newThemeDraft(),
					template: 'split',
					palette: 'classic',
					formFrame: 'full',
					cardColor: '#11223366',
					backgroundImage: PAPER_PRESET
				}}
			/>
		</Page>
	{/snippet}
</Story>

<Story
	name="Floating form area has the brand panel's picture behind it"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		const box = (selector: string) =>
			(canvasElement.querySelector(selector) as HTMLElement).getBoundingClientRect();
		// Full (the default): the panel is its own side.
		await expect(box('.outline__panel').right).toBeLessThanOrEqual(box('.outline__main').left + 1);
		// Floating card: the brand panel runs under the form side, which has no fill.
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.formFrame') }),
			'card'
		);
		await waitFor(() =>
			expect(box('.outline__panel').right).toBeGreaterThan(box('.outline__card').right)
		);
		await expect(
			getComputedStyle(canvasElement.querySelector('.outline__main') as HTMLElement).backgroundColor
		).toBe('rgba(0, 0, 0, 0)');
		// The panel's wording stays on its own side.
		await expect(box('.outline__panel-content').right).toBeLessThanOrEqual(
			box('.outline__main').left + 1
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Form frame is full or a floating card"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		const frame = await canvas.findByRole('combobox', { name: t('th.f.formFrame') });
		const height = (selector: string) =>
			(canvasElement.querySelector(selector) as HTMLElement).getBoundingClientRect().height;
		// Full (to begin with): the form side is the surface; its content has no second card.
		await expect(frame).toHaveValue('full');
		await expect(
			getComputedStyle(canvasElement.querySelector('.outline__card') as HTMLElement).backgroundColor
		).toBe('rgba(0, 0, 0, 0)');
		await expect(height('.outline__card')).toBeLessThan(height('.outline__main'));
		await expect(
			parseFloat(
				getComputedStyle(canvasElement.querySelector('.outline__card') as HTMLElement)
					.borderTopLeftRadius
			)
		).toBe(0);
		// A floating card: a box inside its side, with room around it.
		await userEvent.selectOptions(frame, 'card');
		await waitFor(() =>
			expect(height('.outline__card')).toBeLessThan(height('.outline__main') - 40)
		);
		await expect(
			getComputedStyle(canvasElement.querySelector('.outline__col') as HTMLElement).backgroundColor
		).not.toBe('rgba(0, 0, 0, 0)');
		await expect(
			parseFloat(
				getComputedStyle(canvasElement.querySelector('.outline__col') as HTMLElement)
					.borderTopLeftRadius
			)
		).toBeGreaterThan(0);
		const outer = (
			canvasElement.querySelector('.outline__col') as HTMLElement
		).getBoundingClientRect();
		const tools = (
			canvasElement.querySelector('.outline__col > .tools') as HTMLElement
		).getBoundingClientRect();
		await expect(tools.bottom).toBeLessThan(outer.bottom);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="The form carries wording of its own"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const texts = (selector: string) =>
			[...canvasElement.querySelectorAll(`.outline__card ${selector}`)].map((node) =>
				node.textContent?.trim()
			);
		// Sign in: this tenant has no password, so passkey, then email, then an external IdP.
		await waitFor(() => expect(texts('h3')).toEqual(['Welcome back']));
		await expect(texts('.outline__label')).toEqual(['Email address']);
		await expect(texts('.outline__button')).toEqual([
			'Sign in with Passkey',
			'Continue',
			'Continue with External IdP'
		]);
		await expect(canvasElement.querySelector('.outline__card')?.textContent).not.toContain(
			'Password'
		);
		// Each screen has its own: the code screen asks for the code.
		const screen = await canvas.findByRole('combobox', { name: t('th.preview.screen') });
		await userEvent.selectOptions(screen, 'code');
		await waitFor(() => expect(texts('.outline__label')).toEqual(['Verification code']));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Footer starts with a working link to Authrim"
	play={async ({ canvasElement }) => {
		const footer = () => canvasElement.querySelector<HTMLElement>('.outline__footer');
		await waitFor(() => expect(footer()).not.toBeNull());
		await expect(footer()?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Powered by Authrim');
		const link = footer()?.querySelector('a');
		await expect(link?.getAttribute('href')).toBe('https://authrim.com/');
		// It opens in a window of its own, and the rest of the preview stays a picture.
		await expect(link?.getAttribute('target')).toBe('_blank');
		await expect(link?.getAttribute('rel')).toContain('noopener');
		await expect(link?.closest('[inert]')).toBeNull();
		await expect(canvasElement.querySelector('.outline__stage')?.hasAttribute('inert')).toBe(true);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Tagline sits under the brand name"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.type(await canvas.findByRole('textbox', { name: t('th.f.tagline') }), 'Hello');
		await waitFor(() =>
			expect(canvasElement.querySelector('.outline__header .brand__tagline')?.textContent).toBe(
				'Hello'
			)
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="The header and the brand panel choose their logo separately"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		const header = await canvas.findByRole('combobox', { name: t('th.f.logoDisplay') });
		const panel = await canvas.findByRole('combobox', { name: t('th.f.brandLogoDisplay') });
		const inHeader = () => canvasElement.querySelector('.outline__header .brand__logo');
		const eyebrow = () => canvasElement.querySelector('.outline__eyebrow');
		await waitFor(() => expect(inHeader()).not.toBeNull());
		await waitFor(() => expect(eyebrow()).not.toBeNull());
		// The header shows the name only: its logo goes, the brand panel's name stays.
		await userEvent.selectOptions(header, 'name');
		await waitFor(() => expect(inHeader()).toBeNull());
		await expect(eyebrow()).not.toBeNull();
		// The brand panel shows the logo only: its name goes, the header is as it was.
		await userEvent.selectOptions(panel, 'logo');
		await waitFor(() => expect(eyebrow()).toBeNull());
		await expect(canvasElement.querySelector('.outline__header .brand__name')).not.toBeNull();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split keeps the footer along the whole bottom"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		const screen = canvasElement.querySelector('.outline') as HTMLElement;
		const footer = canvasElement.querySelector('.outline__footer') as HTMLElement;
		const panel = canvasElement.querySelector('.outline__panel') as HTMLElement;
		// Under the brand panel as well as the form, on the bottom edge of the screen.
		await expect(Math.round(footer.getBoundingClientRect().width)).toBe(
			Math.round(screen.getBoundingClientRect().width)
		);
		await expect(Math.round(footer.getBoundingClientRect().bottom)).toBe(
			Math.round(screen.getBoundingClientRect().bottom)
		);
		await expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			panel.getBoundingClientRect().bottom - 1
		);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split keeps the header along the whole top"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		const screen = canvasElement.querySelector('.outline') as HTMLElement;
		const header = canvasElement.querySelector('.outline__header') as HTMLElement;
		const panel = canvasElement.querySelector('.outline__panel') as HTMLElement;
		// Over the brand panel as well as the form, on the top edge of the screen.
		await expect(Math.round(header.getBoundingClientRect().width)).toBe(
			Math.round(screen.getBoundingClientRect().width)
		);
		await expect(Math.round(header.getBoundingClientRect().top)).toBe(
			Math.round(screen.getBoundingClientRect().top)
		);
		await expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			panel.getBoundingClientRect().top + 1
		);
		// The brand panel has no header of its own; the toggle takes the whole header away.
		await expect(panel.querySelector('.outline__header')).toBeNull();
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.click(await canvas.findByLabelText(t('th.t.header')));
		await expect(canvasElement.querySelector('.outline__header')).toBeNull();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split has its own image and opacity"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const png = (name: string) => new File(['x'], name, { type: 'image/png' });
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// Logo, background, form area, favicon, brand panel: the second and last are tested.
		const files = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(files[1], png('background.png'));
		await userEvent.upload(files[4], png('panel.png'));
		const layers = canvasElement.querySelectorAll<HTMLElement>('.outline__image');
		await expect(layers.length).toBe(2);
		await expect(layers[0].closest('.outline__panel')).toBeNull();
		await expect(layers[1].closest('.outline__panel')).not.toBeNull();
		// Each has its own opacity.
		const [background, panel] =
			canvasElement.querySelectorAll<HTMLInputElement>('input[type="range"]');
		fireEvent.input(background, { target: { value: '40' } });
		fireEvent.input(panel, { target: { value: '70' } });
		await waitFor(() => expect(layers[0].style.opacity).toBe('0.4'));
		await waitFor(() => expect(layers[1].style.opacity).toBe('0.7'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Split layout follows its settings"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		const choose = async (label: string, value: string) =>
			userEvent.selectOptions(await canvas.findByRole('combobox', { name: label }), value);
		// A full form frame keeps the two sides apart (a floating one lets the panel run under it).
		await choose(t('th.f.formFrame'), 'full');
		const box = (selector: string) =>
			(canvasElement.querySelector(selector) as HTMLElement).getBoundingClientRect();
		// Narrow form (2/5): the brand side is the wider one; "wide form" turns that around.
		await expect(box('.outline__panel').width).toBeGreaterThan(box('.outline__main').width);
		await choose(t('th.f.splitWidth'), 'wide');
		await expect(box('.outline__panel').width).toBeLessThan(box('.outline__main').width);
		// Brand left by default; "Brand right" puts it after the form.
		await expect(box('.outline__panel').left).toBeLessThan(box('.outline__main').left);
		await choose(t('th.f.splitSide'), 'right');
		await expect(box('.outline__panel').left).toBeGreaterThan(box('.outline__main').left);
		// A floating card is inset from the screen's edge; the full page is not.
		await expect(box('.outline__stage').left).toBeCloseTo(box('.outline').left, 0);
		await choose(t('th.f.splitFrame'), 'card');
		await expect(box('.outline__stage').left).toBeGreaterThan(box('.outline').left);
		// Brand panel "None" (Content tab): nothing on the brand side but its picture.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await choose(t('th.f.brandLogoDisplay'), 'none');
		await expect(canvasElement.querySelector('.outline__panel-content')).toBeNull();
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Brand panel image is offered with Split"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// Logo, favicon, background, form area: the brand panel's picture is not offered without Split.
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(4);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.layout') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(5);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Form area has its own image and opacity"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const png = new File(['x'], 'card.png', { type: 'image/png' });
		const files = () => canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		const layer = () => canvasElement.querySelector<HTMLElement>('.outline__card .outline__image');
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// Standard: logo, background, form area, favicon.
		await userEvent.upload(files()[2], png);
		await waitFor(() => expect(layer()).not.toBeNull());
		const [opacity] = canvasElement.querySelectorAll<HTMLInputElement>('input[type="range"]');
		fireEvent.input(opacity, { target: { value: '30' } });
		await waitFor(() => expect(layer()?.style.opacity).toBe('0.3'));
		// Minimal draws no box, so it neither offers the picture nor draws it.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.layout') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.minimal')) })
		);
		await waitFor(() => expect(layer()).toBeNull());
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		await expect(files()).toHaveLength(3);
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Default wording follows the language"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		const language = await canvas.findByRole('combobox', { name: t('th.f.language') });
		await userEvent.selectOptions(language, 'ja');
		// The console stays as it is; what an empty title falls back to is read in Japanese.
		const title = canvasElement.querySelector('.outline__card h3') as HTMLElement;
		await waitFor(() => expect(title.textContent).toBe(tIn('ja', 'th.preview.welcome')));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Right-to-left language"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('th.f.language') }),
			'ar'
		);
		// The console stays left-to-right; the preview follows the language being edited.
		const screen = canvasElement.querySelector('.outline') as HTMLElement;
		await expect(screen).toHaveAttribute('dir', 'rtl');
		await expect(screen).toHaveAttribute('lang', 'ar');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="A palette sets the colours and the shape, whatever the template"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		// Clean to begin with: its blue accent and quiet, lightly rounded form area.
		await expect(outline.style.getPropertyValue('--ol-accent')).toBe('#2f52c4');
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('8px');
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.palette.glass')) })
		);
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-accent')).toBe('#3a5cb8'));
		// Frosted glass is a rounded pane, translucent (its colour carries an alpha), blurred, with a
		// light rim and a soft shadow.
		await expect(outline.style.getPropertyValue('--ol-card')).toBe('#ffffff61');
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('20px');
		await expect(outline).toHaveAttribute('data-frost', 'true');
		await expect(outline).toHaveAttribute('data-shadow', 'glass');
		// It combines with another template; the colour fields show the palette's colours.
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await expect(outline).toHaveAttribute('data-template', 'split');
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('20px');
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await expect(await canvas.findByRole('textbox', { name: t('th.c.accent') })).toHaveAttribute(
			'placeholder',
			'#3a5cb8'
		);
		// A colour of one's own still replaces the palette's.
		await userEvent.type(await canvas.findByRole('textbox', { name: t('th.c.accent') }), '#112233');
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-accent')).toBe('#112233'));
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Swiss Grid is flat and square, with a ring in place of a shadow"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.palette.swiss-grid')) })
		);
		// Ink on paper, square corners, no blur, no shadow: the Admin console's Swiss Grid.
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-accent')).toBe('#141412'));
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('0px');
		await expect(outline.style.getPropertyValue('--ol-control-radius')).toBe('0px');
		await expect(outline).toHaveAttribute('data-frost', 'false');
		await expect(outline).toHaveAttribute('data-shadow', 'ring');
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		await expect(getComputedStyle(card).boxShadow).toBe('none');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Clear glass is nearly clear, with an iridescent rim and pill buttons"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const outline = canvasElement.querySelector('.outline') as HTMLElement;
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.palette.clear-glass')) })
		);
		await waitFor(() => expect(outline.style.getPropertyValue('--ol-accent')).toBe('#284f97'));
		await expect(outline.style.getPropertyValue('--ol-card')).toBe('#ffffff1a');
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('24px');
		await expect(outline.style.getPropertyValue('--ol-button-radius')).toBe('999px');
		await expect(outline).toHaveAttribute('data-shadow', 'clear');
		// The rim is drawn over the card's edge.
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		await expect(getComputedStyle(card, '::after').content).not.toBe('none');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>

<Story
	name="Minimal has no card, whatever the palette"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.palette.glass')) })
		);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.minimal')) })
		);
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
		const style = getComputedStyle(card);
		await expect(style.boxShadow).toBe('none');
		await expect(style.backdropFilter === 'none' || style.backdropFilter === '').toBe(true);
		await expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
	}}
>
	{#snippet template()}
		<Page><ThemeEditor /></Page>
	{/snippet}
</Story>
