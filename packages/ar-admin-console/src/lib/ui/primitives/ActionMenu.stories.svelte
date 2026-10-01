<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import ActionMenu from './ActionMenu.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Action menu',
		component: ActionMenu,
		tags: ['autodocs'],
		args: { size: 'md', framed: false, disabled: false },
		parameters: {
			docs: {
				description: {
					component:
						'A “⋯” button with a short list of actions for one item — the less frequent ones (move up, move down, remove), kept out of the way until wanted. The list opens in the top layer, so a clipped container does not cut it. Keys follow the menu button pattern: Enter, Space or ↓ open it on the first action (↑ on the last), ↑ / ↓ / Home / End move, Esc or a press outside closes it and focus returns to the button. Unavailable actions are skipped. `framed` draws a faint box, for places where a bare “⋯” could be read as part of a line or diagram.'
				}
			}
		}
	});
</script>

<script lang="ts">
	let last = $state('');
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: sample('rowActions') });
		button.focus();
		await userEvent.keyboard('{ArrowDown}');
		const menu = await canvas.findByRole('menu');
		// The first action is unavailable here, so the menu starts on the second.
		await waitFor(() =>
			expect(within(menu).getByRole('menuitem', { name: sample('moveDown') })).toHaveFocus()
		);
		await userEvent.keyboard('{ArrowDown}');
		expect(within(menu).getByRole('menuitem', { name: sample('delete') })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(button).toHaveFocus());
		expect(button).toHaveAttribute('aria-expanded', 'false');
	}}
>
	{#snippet template(args)}
		<div style="display:flex;align-items:center;gap:12px">
			<ActionMenu
				{...args}
				label={sample('rowActions')}
				actions={[
					{ label: sample('moveUp'), icon: 'arrowUp', disabled: true, onselect: () => {} },
					{
						label: sample('moveDown'),
						icon: 'arrowDown',
						onselect: () => (last = sample('moveDown'))
					},
					{
						label: sample('delete'),
						icon: 'trash',
						danger: true,
						onselect: () => (last = sample('delete'))
					}
				]}
			/>
			<span aria-live="polite">{last}</span>
		</div>
	{/snippet}
</Story>

<Story name="Framed, small" args={{ size: 'sm', framed: true }}>
	{#snippet template(args)}
		<ActionMenu
			{...args}
			label={sample('rowActions')}
			actions={[
				{ label: sample('moveUp'), icon: 'arrowUp', onselect: () => {} },
				{ label: sample('moveDown'), icon: 'arrowDown', onselect: () => {} },
				{ label: sample('delete'), icon: 'trash', danger: true, onselect: () => {} }
			]}
		/>
	{/snippet}
</Story>
