<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '../patterns/Card.svelte';
	import HighlightSettings from './HighlightSettings.svelte';
	import TextField from '../primitives/TextField.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import { Draft } from '../save/draft.svelte';
	const draft = new Draft({ name: 'Authrim', enabled: false });
</script>

<div class="demo">
	<Card title={t('highlight.title')} flush><HighlightSettings /></Card>
	<SaveScope {draft} onsave={() => {}} guardNavigation={false}>
		<Card title={t('time.example')}>
			<TextField label="Application name" bind:value={draft.value.name} field="name" />
			<Checkbox bind:checked={draft.value.enabled} field="enabled">Require approval</Checkbox>
		</Card>
	</SaveScope>
</div>

<style>
	.demo {
		display: grid;
		gap: 24px;
		max-width: 800px;
		padding-bottom: 100px;
	}
</style>
