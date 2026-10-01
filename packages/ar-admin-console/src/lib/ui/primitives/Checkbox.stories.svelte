<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import CheckboxGroup from '../patterns/CheckboxGroup.svelte';
	import { sample } from '../stories/sample';
	import Checkbox from './Checkbox.svelte';

	// The props table's main tab (see named()).
	named(Checkbox, 'Checkbox');

	const { Story } = defineMeta({
		title: 'Primitives/Checkbox',
		component: Checkbox,
		subcomponents: subcomponents({ CheckboxGroup }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Choice that is confirmed later with a SaveBar. Built on a native checkbox, so it works with forms and keyboards; state is not shown by position, so nothing mirrors in RTL.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<div style="display:grid;gap:12px">
			<Checkbox checked description={sample('passkeyDesc')}>{sample('passkey')}</Checkbox>
			<Checkbox>{sample('emailCode')}</Checkbox>
			<Checkbox disabled>{sample('sms')}</Checkbox>
		</div>
	{/snippet}
</Story>

<Story name="With an info tip">
	{#snippet template()}
		<Checkbox checked info={sample('passkeyDesc')}>{sample('passkey')}</Checkbox>
	{/snippet}
</Story>

<Story name="Group (select all)">
	{#snippet template()}
		<div style="max-width:320px">
			<CheckboxGroup
				title={sample('usersDb')}
				selected={['users:read']}
				options={[
					{ value: 'users:read', label: sample('permView'), description: sample('permViewDesc') },
					{
						value: 'users:write',
						label: sample('permWrite'),
						description: sample('permWriteDesc')
					},
					{ value: 'users:delete', label: sample('delete'), description: sample('permDeleteDesc') }
				]}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Sizes">
	{#snippet template()}
		<div style="display:grid;gap:16px">
			<Checkbox checked description={sample('passkeyDesc')}>{sample('passkey')}</Checkbox>
			<Checkbox size="sm" checked description={sample('passkeyDesc')}>{sample('passkey')}</Checkbox>
			<Checkbox size="sm">{sample('emailCode')}</Checkbox>
		</div>
	{/snippet}
</Story>
