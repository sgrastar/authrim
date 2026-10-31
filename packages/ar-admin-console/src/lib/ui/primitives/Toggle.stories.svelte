<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import Toggle from './Toggle.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Toggle',
		component: Toggle,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Switch for settings that take effect **immediately** (enable a flow, turn a feature on). Anything confirmed with Save uses Checkbox instead. The knob moves with the reading direction.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<div style="display:flex;gap:12px">
			<Toggle label={sample('enableFlow')} checked />
			<Toggle label={sample('requireMfa')} />
			<Toggle label={sample('disabled')} disabled />
		</div>
	{/snippet}
</Story>

<Story
	name="Interaction"
	play={async ({ canvasElement }) => {
		const toggle = within(canvasElement).getByRole('switch');
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await userEvent.click(toggle);
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
	}}
>
	{#snippet template()}<Toggle label={sample('requireMfa')} />{/snippet}
</Story>

<Story name="Sizes">
	{#snippet template()}
		<div style="display:flex;align-items:center;gap:16px">
			<Toggle label={sample('enableFlow')} checked />
			<Toggle label={sample('enableFlow')} size="sm" checked />
			<Toggle label={sample('requireMfa')} size="sm" />
		</div>
	{/snippet}
</Story>
