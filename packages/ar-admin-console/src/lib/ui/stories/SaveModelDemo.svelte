<script lang="ts">
	import Badge from '../primitives/Badge.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import Card from '../patterns/Card.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import SettingRow from '../patterns/SettingRow.svelte';
	import { sample } from './sample';

	/** Storybook demo of the save model: toggles apply at once, checkboxes wait for Save. */
	let enabled = $state(true);
	const methods = new Draft({ passkey: true, email: false });

	const save = () => new Promise((resolve) => setTimeout(resolve, 600)).then(() => {});
</script>

<div style="display:grid;gap:16px;max-width:720px">
	<Card title={sample('state')} flush>
		<SettingRow icon="plug" title={sample('enableFlow')} description={sample('appliesNow')}>
			{#snippet meta()}
				<Badge tone={enabled ? 'success' : 'neutral'} dot>
					{enabled ? sample('enabled') : sample('disabled')}
				</Badge>
			{/snippet}
			<Toggle label={sample('enableFlow')} bind:checked={enabled} />
		</SettingRow>
	</Card>
	<SaveScope draft={methods} onsave={save}>
		<Card title={sample('loginMethods')} description={sample('notUntilSaved')}>
			<div style="display:grid;gap:12px">
				<Checkbox
					field="passkey"
					bind:checked={methods.value.passkey}
					description={sample('passkeyDesc')}
				>
					{sample('passkey')}
				</Checkbox>
				<Checkbox field="email" bind:checked={methods.value.email}>{sample('emailCode')}</Checkbox>
			</div>
		</Card>
	</SaveScope>
</div>
