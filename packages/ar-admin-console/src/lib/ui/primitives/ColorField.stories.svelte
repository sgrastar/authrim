<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { localized } from '../stories/sample';
	import ColorField from './ColorField.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Color field',
		component: ColorField,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A colour for branding. The swatch opens the system picker; the box takes a hex value pasted from a brand guide (“#3F4FC4”, “3f4fc4”, “#abc”) and stores lower-case #rrggbb. With `contrastWith`, the field says how readable text is against it — the ratio and whether it meets `minContrast` (4.5:1 by default, WCAG AA) — in words and an icon, never colour alone. `presets` offers a palette with one press. With `alpha`, an opacity slider sits beside the box and the colour is kept as “#rrggbbaa” while it is not opaque. With `fallback`, an empty field shows the colour that applies meanwhile (the swatch and the box’s hint), so “not set” is not a blank.'
				}
			}
		}
	});

	const button = () => localized(['ボタンの色', 'Button colour', 'Schaltflächenfarbe', 'لون الزر']);
	const white = () => localized(['白い文字', 'white text', 'weißer Schrift', 'النص الأبيض']);
</script>

<Story
	name="With a contrast check"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const hex = canvas.getByRole('textbox');
		await userEvent.clear(hex);
		await userEvent.type(hex, 'F5A');
		await userEvent.tab();
		// "#F5A" is read as #ff55aa; with white text it is too pale for AA.
		await waitFor(() => expect(hex).toHaveValue('#ff55aa'));
		await expect(
			canvas.getByText(new RegExp(t('color.fail', { min: 4.5 }).replace(/[()]/g, '\\$&')))
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<ColorField label={button()} value="#3f4fc4" contrastWith="#ffffff" contrastLabel={white()} />
	{/snippet}
</Story>

<Story
	name="With an opacity"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const slider = canvas.getByRole('slider');
		const swatch = canvasElement.querySelector('.color__swatch') as HTMLElement;
		await expect(swatch.style.getPropertyValue('--swatch')).toBe('#3f4fc4');
		// Half see-through: the box still holds the colour alone; the swatch carries the opacity.
		fireEvent.input(slider, { target: { value: '50' } });
		await waitFor(() => expect(swatch.style.getPropertyValue('--swatch')).toBe('#3f4fc480'));
		await expect(canvas.getByRole('textbox')).toHaveValue('#3f4fc4');
		await expect(canvas.getByText('50%')).toBeInTheDocument();
		// Typing over the colour keeps the opacity.
		const hex = canvas.getByRole('textbox');
		await userEvent.tripleClick(hex);
		await userEvent.keyboard('#112233');
		await waitFor(() => expect(swatch.style.getPropertyValue('--swatch')).toBe('#11223380'));
		// Clearing the box is "not set": the theme's own colour, fully opaque, in the slider too.
		await userEvent.clear(hex);
		await waitFor(() => expect(canvas.getByText('100%')).toBeInTheDocument());
	}}
>
	{#snippet template()}
		<ColorField label={button()} value="#3f4fc4" alpha />
	{/snippet}
</Story>

<Story
	name="A see-through colour shows no contrast"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const sentence = () => canvasElement.querySelector('.color__contrast');
		await expect(sentence()).not.toBeNull();
		fireEvent.input(canvas.getByRole('slider'), { target: { value: '50' } });
		await waitFor(() => expect(sentence()).toBeNull());
	}}
>
	{#snippet template()}
		<ColorField
			label={button()}
			value="#3f4fc4"
			alpha
			contrastWith="#ffffff"
			contrastLabel={white()}
		/>
	{/snippet}
</Story>

<Story
	name="With a fallback"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const hex = canvas.getByRole('textbox');
		// Empty, but the colour in effect shows in the box's hint.
		await expect(hex).toHaveValue('');
		await expect(hex).toHaveAttribute('placeholder', '#2f52c4');
		await userEvent.type(hex, '#b4235a');
		await waitFor(() => expect(hex).toHaveValue('#b4235a'));
		// Clearing it goes back to the fallback.
		await userEvent.clear(hex);
		await expect(hex).toHaveAttribute('placeholder', '#2f52c4');
	}}
>
	{#snippet template()}
		<ColorField label={button()} fallback="#2f52c4" />
	{/snippet}
</Story>

<Story name="With a palette">
	{#snippet template()}
		<ColorField
			label={button()}
			value="#1f6f5c"
			contrastWith="#ffffff"
			contrastLabel={white()}
			presets={['#1f6f5c', '#3f4fc4', '#b4235a', '#2c2724']}
		/>
	{/snippet}
</Story>
