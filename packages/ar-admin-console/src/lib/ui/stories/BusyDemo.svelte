<script lang="ts">
	import BusyScope from '../busy/BusyScope.svelte';
	import Form from '../patterns/Form.svelte';
	import Button from '../primitives/Button.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import Link from '../primitives/Link.svelte';
	import TextArea from '../primitives/TextArea.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { toast } from '../toast/toast.svelte';
	import { sample } from './sample';

	/**
	 * Storybook demo: a form with its own Save button (no save bar). Changed fields are still
	 * marked; while saving, every control in the form stops taking input and the save button
	 * keeps focus with its spinner. `busy` fixes the state for tests and screenshots.
	 */
	interface Props {
		busy?: boolean;
		/** How long the pretend save takes. */
		duration?: number;
	}

	let { busy = false, duration = 1600 }: Props = $props();

	const app = new Draft({
		name: 'Acme Corporation',
		description: sample('appDescriptionValue'),
		enabled: false
	});

	async function save() {
		await new Promise((resolve) => setTimeout(resolve, duration));
		toast.success(sample('savedToast'));
	}
</script>

<BusyScope {busy}>
	<SaveScope draft={app} onsave={save} bar={false}>
		{#snippet children(form)}
			<Form
				label={sample('settings')}
				onsubmit={(event) => {
					event.preventDefault();
					form.save();
				}}
			>
				<TextField field="name" label={sample('displayName')} bind:value={app.value.name} />
				<TextArea
					field="description"
					label={sample('appDescription')}
					hint={sample('appDescriptionHint')}
					maxlength={200}
					counter
					rows={3}
					bind:value={app.value.description}
				/>
				<Checkbox field="enabled" bind:checked={app.value.enabled}>{sample('enableFlow')}</Checkbox>
				<Link href="#docs" newTab>{sample('docsLink')}</Link>
				<div style="display:flex;gap:8px">
					<Button variant="primary" type="submit" loading={busy || form.saving}>
						{busy || form.saving ? sample('saving') : sample('save')}
					</Button>
					<Button variant="ghost" onclick={() => form.discard()}>{sample('cancel')}</Button>
				</div>
			</Form>
		{/snippet}
	</SaveScope>
</BusyScope>
