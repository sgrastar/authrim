<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import LanguageSettingsDemo from '../stories/LanguageSettingsDemo.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';
	import ChoiceGrid from './ChoiceGrid.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Choice grid',
		component: ChoiceGrid,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Many short choices of one kind — languages, scopes, countries — as checkboxes in a ruled grid that fills as many columns as fit. The head row counts what is chosen and offers select all / clear; with `max`, the rest become unavailable once the limit is reached. A choice that must stay on (the default language) is `locked` with a `note`.\n\n**One control per cell.** A cell never holds two controls that mean different things (shown / default / listed first). Ask each question in its own step: a second grid limited to what the first one chose, or a Select for a single pick (the default). The “Language settings” story rebuilds the legacy screen this way.'
				}
			}
		}
	});

	const scopes = [
		'openid',
		'profile',
		'email',
		'address',
		'phone',
		'offline_access',
		'groups',
		'roles'
	];
	let chosenScopes = $state(['openid', 'profile', 'email']);
</script>

<Story
	name="Language settings"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [shown] = canvas.getAllByRole('group');
		// Clearing keeps the default language: it is locked on.
		await userEvent.click(within(shown).getByRole('button', { name: t('table.clearSelection') }));
		const checked = within(shown).getAllByRole('checkbox', { checked: true });
		await expect(checked).toHaveLength(1);
		await expect(checked[0]).toBeDisabled();
		// With fewer than 11 languages shown, "listed first" is explained, not offered.
		await expect(canvas.getByText(sample('langFirstNeedsMore'))).toBeInTheDocument();
	}}
>
	{#snippet template()}<div style="max-width:980px"><LanguageSettingsDemo /></div>{/snippet}
</Story>

<Story name="With a limit">
	{#snippet template()}
		<Card title="Scopes">
			<ChoiceGrid
				label="Scopes"
				max={4}
				minWidth="160px"
				options={scopes.map((scope) => ({ value: scope, label: scope }))}
				bind:selected={chosenScopes}
			/>
		</Card>
	{/snippet}
</Story>
