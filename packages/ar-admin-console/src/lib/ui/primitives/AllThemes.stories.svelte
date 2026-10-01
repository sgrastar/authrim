<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import ThemeMatrix from '../stories/ThemeMatrix.svelte';
	import Badge from './Badge.svelte';
	import Button from './Button.svelte';
	import Checkbox from './Checkbox.svelte';
	import TextField from './TextField.svelte';
	import Toggle from './Toggle.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/All themes',
		parameters: { layout: 'fullscreen' }
	});
</script>

<Story name="All themes">
	{#snippet template()}
		<ThemeMatrix>
			<div style="display:flex;flex-wrap:wrap;gap:8px">
				<Button variant="primary">{sample('create')}</Button>
				<Button>{sample('cancel')}</Button>
				<Button variant="danger">{sample('delete')}</Button>
			</div>
			<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
				<Toggle label={sample('enableFlow')} checked />
				<Checkbox checked>{sample('passkey')}</Checkbox>
				<Badge tone="success" dot>{sample('enabled')}</Badge>
				<Badge tone="warning">{sample('missing')}</Badge>
			</div>
			<TextField label={sample('tenantName')} value="Acme" />
		</ThemeMatrix>
	{/snippet}
</Story>
