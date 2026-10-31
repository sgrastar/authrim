<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
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
						'A colour for branding. The swatch opens the system picker; the box takes a hex value pasted from a brand guide (“#3F4FC4”, “3f4fc4”, “#abc”) and stores lower-case #rrggbb. With `contrastWith`, the field says how readable text is against it — the ratio and whether it meets `minContrast` (4.5:1 by default, WCAG AA) — in words and an icon, never colour alone. `presets` offers a palette with one press.'
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
