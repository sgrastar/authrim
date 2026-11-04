<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, within } from 'storybook/test';
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
						'Customization → Themes: how the tenant’s sign-in screens look (legacy `/admin/themes`, `login-ui.*` settings).\n\nEditing on the start side (one tab per section: Design, Brand, Text, Images, Advanced), the preview on the end side (screen, colour mode, phone or desktop width). What is edited is drawn in the preview as it is typed, chosen or uploaded. It is held in the page: nothing is read from or saved to the Admin API yet, and custom CSS is not applied in the preview yet. The preview shows an outline of a sign-in screen, not the real screens.\n\nThe parts it uses are the console’s own; the ones it still lacks are listed in the pull request.'
				}
			}
		}
	});
</script>

<Story name="Frame">
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
		await expect(layers[0].style.opacity).toBe('0.4');
		await expect(layers[1].style.opacity).toBe('0.7');
	}}
>
	{#snippet template()}
		<Themes />
	{/snippet}
</Story>

<Story
	name="Brand panel image waits for Split"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('tab', { name: t('th.tab.images') }));
		const files = canvasElement.querySelectorAll<HTMLInputElement>('input[type="file"]');
		await expect(files[3]).toBeDisabled();
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
