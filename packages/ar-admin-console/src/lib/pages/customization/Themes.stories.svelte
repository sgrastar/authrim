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
						'Customization → Themes: how the tenant’s sign-in screens look (legacy `/admin/themes`, `login-ui.*` settings).\n\nThe preview on the start side (screen, colour mode, phone or desktop width), the inspector on the end side (one tab per section: Design, Brand, Text, Images, Advanced), set a size down because it is narrow and holds many controls. What is edited is drawn in the preview as it is typed, chosen or uploaded. It is held in the page: nothing is read from or saved to the Admin API yet, and custom CSS is not applied in the preview yet. The preview shows an outline of a sign-in screen, not the real screens.\n\nThe parts it uses are the console’s own; the ones it still lacks are listed in the pull request.'
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
	name="Brand name shows in the preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.brand') }));
		const name = await canvas.findByRole('textbox', { name: t('th.f.brandName') });
		await userEvent.clear(name);
		await userEvent.type(name, 'Acme Corp');
		// The name is in the preview's header and again in its footer.
		await expect((await canvas.findAllByText('Acme Corp')).length).toBeGreaterThan(0);
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
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.advanced') }));
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
		// Content: nothing on the brand side but its picture.
		await choose(t('th.f.brandContent'), 'none');
		await expect(canvasElement.querySelector('.outline__panel-content')).toBeNull();
	}}
>
	{#snippet template()}
		<Themes />
	{/snippet}
</Story>

<Story
	name="Split background: brand only and panel image"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const png = (name: string) => new File(['x'], name, { type: 'image/png' });
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		// The background image first (Images tab), then the choice in Design.
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		const files = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(files[2], png('background.png'));
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		const background = await canvas.findByRole('combobox', { name: t('th.f.splitBg') });
		// Shared: the picture is behind the whole screen.
		await expect(canvasElement.querySelectorAll('.outline > .outline__image')).toHaveLength(1);
		// Brand only: it moves to the brand side, and the form side has a fill (colours) instead.
		await userEvent.selectOptions(background, 'brand');
		await expect(canvasElement.querySelectorAll('.outline > .outline__image')).toHaveLength(0);
		await expect(canvasElement.querySelectorAll('.outline__panel .outline__image')).toHaveLength(1);
		await expect(await canvas.findByLabelText(t('th.c.panel'))).toBeInTheDocument();
		// Panel image: the form side has a picture of its own, with its own opacity (70% to begin with).
		await userEvent.selectOptions(background, 'panel');
		const form = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await userEvent.upload(form[form.length - 1], png('form.png'));
		const layer = canvasElement.querySelector('.outline__main .outline__image') as HTMLElement;
		await expect(layer.style.opacity).toBe('0.7');
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
		// Logo, favicon, background: the brand panel's picture is not offered without Split.
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(3);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.look') }));
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(t('th.tpl.split')) })
		);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		await expect(canvasElement.querySelectorAll('input[type="file"]')).toHaveLength(4);
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
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.text') }));
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
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.text') }));
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
