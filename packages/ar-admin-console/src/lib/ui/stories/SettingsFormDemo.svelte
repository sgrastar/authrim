<script lang="ts">
	import Card from '../patterns/Card.svelte';
	import Columns from '../patterns/Columns.svelte';
	import Form from '../patterns/Form.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import RadioGroup from '../primitives/RadioGroup.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';
	import Select from '../primitives/Select.svelte';
	import Slider from '../primitives/Slider.svelte';
	import TextArea from '../primitives/TextArea.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { sample } from './sample';

	/**
	 * Storybook demo: a settings page inside a SaveScope. Change anything and the control is
	 * marked and the save bar rises; change it back, save or discard and both go away.
	 */
	interface Props {
		/** Make saving fail, to show the error path. */
		failSave?: boolean;
	}

	let { failSave = false }: Props = $props();

	const draft = new Draft({
		name: 'Acme Corporation',
		description: sample('appDescriptionValue'),
		region: 'jp',
		mfa: 'risk',
		period: 'week',
		rollout: 25,
		passkey: true,
		email: false
	});

	async function save() {
		await new Promise((resolve) => setTimeout(resolve, 900));
		if (failSave) throw new Error('');
	}
</script>

<SaveScope {draft} onsave={save}>
	<Card title={sample('settings')}>
		<Form label={sample('settings')} onsubmit={(event) => event.preventDefault()}>
			<Columns>
				<TextField field="name" label={sample('tenantName')} bind:value={draft.value.name} />
				<Select
					field="region"
					label={sample('region')}
					bind:value={draft.value.region}
					options={[
						{ value: 'jp', label: sample('regionJp') },
						{ value: 'eu', label: sample('regionEu') },
						{ value: 'us', label: sample('regionUs') },
						{ value: 'apac', label: sample('regionApac') }
					]}
				/>
			</Columns>
			<TextArea
				field="description"
				label={sample('appDescription')}
				rows={3}
				maxlength={200}
				counter
				bind:value={draft.value.description}
			/>
			<RadioGroup
				field="mfa"
				label={sample('mfaMode')}
				bind:value={draft.value.mfa}
				options={[
					{ value: 'off', label: sample('mfaOff'), description: sample('mfaOffDesc') },
					{ value: 'risk', label: sample('mfaRisk'), description: sample('mfaRiskDesc') },
					{ value: 'always', label: sample('mfaAlways'), description: sample('mfaAlwaysDesc') }
				]}
			/>
			<SegmentedControl
				field="period"
				label={sample('period')}
				hideLabel={false}
				bind:value={draft.value.period}
				options={[
					{ value: 'day', label: sample('day') },
					{ value: 'week', label: sample('week') },
					{ value: 'month', label: sample('month') }
				]}
			/>
			<Slider
				field="rollout"
				label={sample('rolloutShare')}
				format="percent"
				bind:value={draft.value.rollout}
			/>
			<Checkbox
				field="passkey"
				description={sample('passkeyDesc')}
				bind:checked={draft.value.passkey}
			>
				{sample('passkey')}
			</Checkbox>
			<Checkbox field="email" bind:checked={draft.value.email}>{sample('emailCode')}</Checkbox>
		</Form>
	</Card>
</SaveScope>
