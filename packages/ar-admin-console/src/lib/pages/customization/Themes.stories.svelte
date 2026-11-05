<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import Themes from './Themes.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Themes',
		component: Themes,
		// draft: the frame of the page. Nothing is read from or written to the Admin API yet.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Themes: how the tenant’s sign-in screens look (legacy `/admin/themes`, `login-ui.*` settings).\n\nThe preview on the start side (screen, colour mode, phone or desktop width), the inspector on the end side (one tab per section: Design, Content, Images), and custom CSS under both, set a size down because it is narrow and holds many controls. What is edited is drawn in the preview as it is typed, chosen or uploaded. It is held in the page: nothing is read from or saved to the Admin API yet, and custom CSS is not applied in the preview yet. The preview shows an outline of a sign-in screen, not the real screens.\n\nThe parts it uses are the console’s own; the ones it still lacks are listed in the pull request.'
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
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
	{/snippet}
</Story>

<Story
	name="Brand panel settings are offered with Split only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await expect(canvas.queryByRole('textbox', { name: t('th.f.panelTitle') })).toBeNull();
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
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
		<Themes />
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
		<Themes />
	{/snippet}
</Story>

<Story
	name="Typeface shows in the preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
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
		<Themes />
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
		<Themes />
	{/snippet}
</Story>

<Story
	name="Colour and language choices follow the layout switches"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const tools = () => canvasElement.querySelectorAll('.tools__item');
		await waitFor(() => expect(tools()).toHaveLength(2));
		await userEvent.click(await canvas.findByLabelText(t('th.t.themeToggle')));
		await waitFor(() => expect(tools()).toHaveLength(1));
		await userEvent.click(await canvas.findByLabelText(t('th.t.language')));
		await waitFor(() => expect(tools()).toHaveLength(0));
		// With no header they float at the top end of the screen, not along a band.
		await userEvent.click(await canvas.findByLabelText(t('th.t.themeToggle')));
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.content') }));
		await userEvent.click(await canvas.findByLabelText(t('th.t.header')));
		await waitFor(() => expect(canvasElement.querySelector('.outline__tools')).not.toBeNull());
	}}
>
	{#snippet template()}
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
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
		<Themes />
	{/snippet}
</Story>

<Story
	name="Brand panel image is offered with Split"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// Logo, favicon, background, login area: the brand panel's picture is not offered without Split.
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(4);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(5);
	}}
>
	{#snippet template()}
		<Themes />
	{/snippet}
</Story>

<Story
	name="Login area has its own image and opacity"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const png = new File(['x'], 'card.png', { type: 'image/png' });
		const files = () => canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		const layer = () => canvasElement.querySelector<HTMLElement>('.outline__card .outline__image');
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		// Standard: logo, favicon, background, login area (the last).
		await userEvent.upload(files()[3], png);
		await waitFor(() => expect(layer()).not.toBeNull());
		const [opacity] = canvasElement.querySelectorAll<HTMLInputElement>('input[type="range"]');
		fireEvent.input(opacity, { target: { value: '30' } });
		await waitFor(() => expect(layer()?.style.opacity).toBe('0.3'));
		// Minimal draws no box, so it neither offers the picture nor draws it.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.minimal')) })
		);
		await waitFor(() => expect(layer()).toBeNull());
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		await expect(files()).toHaveLength(3);
	}}
>
	{#snippet template()}
		<Themes />
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
		await expect(title.textContent).toBe(tIn('ja', 'th.screen.signIn'));
	}}
>
	{#snippet template()}
		<Themes />
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
		<Themes />
	{/snippet}
</Story>
