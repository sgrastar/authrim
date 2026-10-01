<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import CheckboxGroup from '../patterns/CheckboxGroup.svelte';
	import Columns from '../patterns/Columns.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { sample } from './sample';

	/** Storybook demo: a role's permissions in two columns of groups, saved with a SaveScope. */
	const role = new Draft({ permissions: ['users:read', 'clients:read', 'clients:write'] });

	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<SaveScope draft={role} onsave={save}>
	<Card title={sample('permTitle')} description={sample('permHint')}>
		<Columns align="stretch" minWidth="260px">
			<CheckboxGroup
				field="permissions"
				title={sample('grpConsole')}
				bind:selected={role.value.permissions}
				options={[
					{
						value: 'console:access',
						label: sample('permConsole'),
						description: sample('permConsoleDesc')
					}
				]}
			/>
			<CheckboxGroup
				field="permissions"
				title={sample('usersDb')}
				bind:selected={role.value.permissions}
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
			<CheckboxGroup
				field="permissions"
				title={sample('grpClients')}
				bind:selected={role.value.permissions}
				options={[
					{ value: 'clients:read', label: sample('permView'), description: sample('permViewDesc') },
					{
						value: 'clients:write',
						label: sample('permWrite'),
						description: sample('permWriteDesc')
					},
					{
						value: 'clients:delete',
						label: sample('delete'),
						description: sample('permDeleteDesc')
					}
				]}
			/>
			<CheckboxGroup
				field="permissions"
				title={sample('tabSessions')}
				bind:selected={role.value.permissions}
				options={[
					{
						value: 'sessions:read',
						label: sample('permView'),
						description: sample('permViewDesc')
					},
					{
						value: 'sessions:revoke',
						label: sample('permRevoke'),
						description: sample('permRevokeDesc')
					}
				]}
			/>
		</Columns>
	</Card>
</SaveScope>
