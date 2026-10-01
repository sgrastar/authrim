<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { t } from '$lib/i18n/i18n.svelte';
	import { sample } from '../stories/sample';
	import ThemeMatrix from '../stories/ThemeMatrix.svelte';
	import Callout from './Callout.svelte';
	import Card from './Card.svelte';
	import ScopeNote from './ScopeNote.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/All themes',
		parameters: { layout: 'fullscreen' }
	});
</script>

<Story name="All themes">
	{#snippet template()}
		<ThemeMatrix>
			<Card title={sample('loginMethods')} description={sample('notUntilSaved')}>
				<Callout tone="warning">{sample('requiredBody')}</Callout>
			</Card>
			<ScopeNote
				kind="inherit"
				title={t('plat.inherit.title')}
				body={t('plat.inherit.body')}
				pill={t('plat.inherit.pill')}
			/>
		</ThemeMatrix>
	{/snippet}
</Story>
