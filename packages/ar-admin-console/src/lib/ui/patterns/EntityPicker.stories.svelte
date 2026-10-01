<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { searchPeople } from '../stories/people';
	import { localized } from '../stories/sample';
	import EntityPicker from './EntityPicker.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Entity picker',
		component: EntityPicker,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Find things by typing and pick one or several — members of a group, roles to assign, clients a grant covers. Results come from `search(query, signal)` (the Admin API), so it scales to thousands; earlier requests are aborted as the admin types. Editable combobox: ↓ / ↑ move, Enter picks, Esc closes, Backspace in an empty box removes the last pick. Picks are chips with their own remove button; each change is announced. Already picked results stay listed as “Selected”. For a fixed, short list use Select or SelectMenu instead.'
				}
			}
		}
	});

	const members = () => localized(['メンバー', 'Members', 'Mitglieder', 'الأعضاء']);
	const hint = () =>
		localized(['名前またはメールアドレス', 'Name or email', 'Name oder E-Mail', 'الاسم أو البريد']);
</script>

<Story
	name="Several"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('combobox');
		await userEvent.click(box);
		await userEvent.type(box, 'emi');
		const option = await within(canvasElement.ownerDocument.body).findByRole('option', {
			name: /Emi Sato/
		});
		await expect(option).toBeInTheDocument();
		await userEvent.keyboard('{Enter}');
		await waitFor(() =>
			expect(
				canvas.getByRole('button', { name: t('picker.remove', { name: 'Emi Sato' }) })
			).toBeInTheDocument()
		);
		// Backspace in the empty box takes the last pick back.
		await userEvent.keyboard('{Backspace}');
		await waitFor(() =>
			expect(
				canvas.queryByRole('button', { name: t('picker.remove', { name: 'Emi Sato' }) })
			).toBeNull()
		);
	}}
>
	{#snippet template()}
		<div style="max-width:480px;min-height:320px">
			<EntityPicker
				label={members()}
				placeholder={hint()}
				search={searchPeople}
				items={[{ value: 'u-aiko', label: 'Aiko Tanaka', description: 'aiko@example.com' }]}
			/>
		</div>
	{/snippet}
</Story>

<Story name="One">
	{#snippet template()}
		<div style="max-width:480px;min-height:320px">
			<EntityPicker
				label={localized(['担当者', 'Owner', 'Verantwortlich', 'المسؤول'])}
				placeholder={hint()}
				multiple={false}
				search={searchPeople}
			/>
		</div>
	{/snippet}
</Story>
