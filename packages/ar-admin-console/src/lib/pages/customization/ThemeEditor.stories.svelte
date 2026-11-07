<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
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
	const storyPresets = async (): Promise<BgPreset[]> =>
		Object.entries(PRESET_FILES).flatMap(([path, url]) => {
			const match = /\/backgrounds\/([^/]+)\/([^/]+)\.webp$/.exec(path);
			return match
				? [{ id: `${match[1]}/${match[2]}`, category: match[1], name: match[2], url }]
				: [];
		});

	const { Story } = defineMeta({
		title: 'Pages/Customization/Theme editor',
		component: ThemeEditor,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Themes → a theme: how the tenant’s sign-in screens look. The theme page (`ThemeEditorPage`) puts this editor under its header (the theme’s name, Save, Apply) and loads and saves the draft through `/api/admin/login-ui/themes`.\n\nThe preview on the start side (screen, colour mode, phone or desktop width), the inspector on the end side (one tab per section: Layout, Design, Content, Images), and custom CSS under both, set a size down because it is narrow and holds many controls. What is edited is drawn in the preview as it is typed, chosen or uploaded; custom CSS is not applied in the preview. The preview shows an outline of a sign-in screen, not the real screens.'
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
		const card = canvasElement.querySelector('.outline__card') as HTMLElement;
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
		await userEvent.click(await canvas.findByRole('radio', { name: t('th.mode.dark') }));
		await waitFor(() => expect(background).toHaveAttribute('placeholder', '#0b0e16'));
		await expect(accent).toHaveAttribute('placeholder', '#93aef2');
		// A colour of one's own replaces it, in the preview too.
		await userEvent.type(accent, '#b4235a');
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
		await userEvent.upload(files[files.length - 1], png);
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
		// Full (to begin with): the form area fills its side, with no card around it.
		await expect(frame).toHaveValue('full');
		await expect(height('.outline__card')).toBeGreaterThan(height('.outline__main') - 60);
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
			parseFloat(
				getComputedStyle(canvasElement.querySelector('.outline__card') as HTMLElement)
					.borderTopLeftRadius
			)
		).toBeGreaterThan(0);
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
		// Logo, favicon, background, brand panel: the last two are the ones under test.
		const files = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(files[2], png('background.png'));
		await userEvent.upload(files[3], png('panel.png'));
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
		// Standard: logo, favicon, background, form area (the last).
		await userEvent.upload(files()[3], png);
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
		// Meridian to begin with: its blue accent, rounded form area.
		await expect(outline.style.getPropertyValue('--ol-accent')).toBe('#2f52c4');
		await expect(outline.style.getPropertyValue('--ol-card-radius')).toBe('20px');
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
