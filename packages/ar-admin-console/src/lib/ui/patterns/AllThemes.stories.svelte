<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { t } from '$lib/i18n/i18n.svelte';
	import { sample } from '../stories/sample';
	import ThemeMatrix from '../stories/ThemeMatrix.svelte';
	import Callout from './Callout.svelte';
	import Card from './Card.svelte';
	import ChoiceCards from './ChoiceCards.svelte';
	import ScopeNote from './ScopeNote.svelte';
	import TextField from '../primitives/TextField.svelte';
	import Wizard from './Wizard.svelte';
	import WizardSteps from './WizardSteps.svelte';

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
			<ChoiceCards
				label="Where do you want to connect?"
				columns={2}
				value="out"
				options={[
					{
						value: 'out',
						label: 'Let an app sign in through Authrim',
						description: 'Authrim is the identity provider.',
						icon: 'arrowOut'
					},
					{
						value: 'in',
						label: 'Sign in through another provider',
						description: 'Authrim is the relying party.',
						icon: 'arrowIn',
						badge: 'Later',
						disabled: true
					}
				]}
			/>
			<WizardSteps
				steps={[
					{ id: 'one', label: 'Where to connect' },
					{ id: 'two', label: 'App details' },
					{ id: 'three', label: 'Sign-in method' }
				]}
				current={1}
			/>
			<Wizard
				steps={[
					{ id: 'one', label: 'Where to connect' },
					{ id: 'two', label: 'App details' },
					{ id: 'three', label: 'Review' }
				]}
				current={1}
			>
				<TextField label="Name" hint="Shown to your admins." />
			</Wizard>
			<ScopeNote
				kind="inherit"
				title={t('plat.inherit.title')}
				body={t('plat.inherit.body')}
				pill={t('plat.inherit.pill')}
			/>
		</ThemeMatrix>
	{/snippet}
</Story>
