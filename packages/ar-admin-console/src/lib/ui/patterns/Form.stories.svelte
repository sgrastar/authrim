<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import TextField from '../primitives/TextField.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';
	import Form from './Form.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Form',
		component: Form,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: { component: 'Vertical form layout. Pages never space fields themselves.' }
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<Card title={sample('createTenant')}>
			<Form onsubmit={(event) => event.preventDefault()}>
				<TextField label={sample('tenantName')} required />
				<TextField label={sample('tenantId')} hint={sample('tenantIdHint')} />
				<div><Button variant="primary" type="submit">{sample('create')}</Button></div>
			</Form>
		</Card>
	{/snippet}
</Story>
