<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import Card from '../patterns/Card.svelte';
	import EmptyState from '../patterns/EmptyState.svelte';
	import PageHeader from '../patterns/PageHeader.svelte';
	import { sample } from '../stories/sample';
	import SaveModelDemo from '../stories/SaveModelDemo.svelte';
	import Page from './Page.svelte';

	const { Story } = defineMeta({
		title: 'Templates/Page',
		component: Page,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Page body. `standard` (1100px) for settings and forms, `wide` (1600px) for lists, tables, logs and dashboards. Both are start-aligned so the content edge never jumps; children reveal top to bottom when the page is entered.'
				}
			}
		}
	});
</script>

<Story name="Settings (standard width)">
	{#snippet template()}
		<Page>
			<PageHeader title={sample('authMethodsTitle')} description={sample('authMethodsDesc')} />
			<SaveModelDemo />
		</Page>
	{/snippet}
</Story>

<Story name="List (wide width)">
	{#snippet template()}
		<Page width="wide">
			<PageHeader title={sample('usersTitle')} description={sample('usersDesc')}>
				{#snippet actions()}<Button variant="primary" icon="plus">{sample('createUser')}</Button
					>{/snippet}
			</PageHeader>
			<Card flush>
				<EmptyState icon="users" title={sample('emptyTitle')} description={sample('emptyDesc')} />
			</Card>
		</Page>
	{/snippet}
</Story>
