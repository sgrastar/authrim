<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import Columns from '../patterns/Columns.svelte';
	import ColumnSpan from '../patterns/ColumnSpan.svelte';
	import Form from '../patterns/Form.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { sample } from './sample';

	/** Storybook demo: user details in two or three columns, saved with a SaveScope. */
	interface Props {
		columns?: 2 | 3;
	}

	let { columns = 2 }: Props = $props();

	const user = new Draft({
		name: 'Aiko Tanaka',
		nickname: '',
		given: 'Aiko',
		family: 'Tanaka',
		username: 'aiko',
		phone: '',
		phoneVerified: false
	});

	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<SaveScope draft={user} onsave={save}>
	<Card title={sample('userInfo')}>
		<Form label={sample('userInfo')} onsubmit={(event) => event.preventDefault()}>
			<Columns {columns} minWidth={columns === 3 ? '180px' : '240px'}>
				<TextField field="given" label={sample('fieldGiven')} bind:value={user.value.given} />
				<TextField field="family" label={sample('fieldFamily')} bind:value={user.value.family} />
				{#if columns === 2}
					<TextField field="name" label={sample('fieldName')} bind:value={user.value.name} />
				{/if}
				<TextField
					field="nickname"
					label={sample('fieldNickname')}
					bind:value={user.value.nickname}
				/>
				<TextField
					field="username"
					label={sample('fieldUsername')}
					bind:value={user.value.username}
				/>
				<TextField
					field="phone"
					label={sample('fieldPhone')}
					type="tel"
					placeholder="+81 90 1234 5678"
					bind:value={user.value.phone}
				/>
				<ColumnSpan>
					<Checkbox
						field="phoneVerified"
						description={sample('phoneVerifiedDesc')}
						bind:checked={user.value.phoneVerified}
					>
						{sample('phoneVerified')}
					</Checkbox>
				</ColumnSpan>
			</Columns>
		</Form>
	</Card>
</SaveScope>
