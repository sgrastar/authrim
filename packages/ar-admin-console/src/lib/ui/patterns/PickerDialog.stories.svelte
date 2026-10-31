<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { TRANSFORMS, TRANSFORM_CATEGORIES } from './mapping-model';
	import PickerDialog from './PickerDialog.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Picker dialog',
		component: PickerDialog,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Choosing one from a catalogue too long for a dropdown — the steps of an attribute mapping — in a ColumnBrowser: groups, the group’s items, and a preview of the item looked at, with the button that applies it. Looking and choosing are two moves, so an item can be read about first. The search at the top narrows groups and items (names, descriptions, keywords). The current choice opens first; its button says it is the current one. Esc closes.'
				}
			}
		}
	});

	/** The attribute mapping's steps, as the editor passes them. */
	const groups = () =>
		TRANSFORM_CATEGORIES.map((category) => ({
			id: category,
			label: t(`map.c.${category}`),
			items: TRANSFORMS.filter((def) => def.category === category).map((def) => ({
				value: def.id,
				label: t(`map.t.${def.id}`),
				description: t(`map.d.${def.id}`),
				keywords: def.id.replaceAll('_', ' ')
			}))
		}));
</script>

<script lang="ts">
	import Button from '../primitives/Button.svelte';

	let open = $state(false);
	let chosen = $state('case');
</script>

<Story
	name="Steps of a mapping"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('map.pickStep') }));
		const dialog = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		// Opens on the current choice, which cannot be chosen again.
		await expect(dialog.getByRole('button', { name: t('map.t.case') })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(dialog.getByRole('button', { name: t('map.pick.current') })).toBeDisabled();
		// Searching by id finds a step in another group; look at it, then apply it.
		await userEvent.keyboard('regex');
		await userEvent.click(await dialog.findByRole('button', { name: t('map.t.regex_replace') }));
		await userEvent.click(await dialog.findByRole('button', { name: t('map.pick.change') }));
		await waitFor(() =>
			expect(canvas.getByTestId('chosen')).toHaveTextContent(t('map.t.regex_replace'))
		);
	}}
>
	{#snippet template()}
		<div style="display:flex;align-items:center;gap:12px">
			<Button onclick={() => (open = true)}>{t('map.pickStep')}</Button>
			<span data-testid="chosen">{t(`map.t.${chosen}` as 'map.t.case')}</span>
			<PickerDialog
				{open}
				title={t('map.pickStep')}
				groups={groups()}
				value={chosen}
				chooseLabel={t('map.pick.change')}
				currentLabel={t('map.pick.current')}
				onchoose={(value) => {
					chosen = value;
					open = false;
				}}
				oncancel={() => (open = false)}
			/>
		</div>
	{/snippet}
</Story>
