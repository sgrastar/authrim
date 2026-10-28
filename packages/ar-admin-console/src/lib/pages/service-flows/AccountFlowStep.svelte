<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import CheckboxGroup from '$lib/ui/patterns/CheckboxGroup.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import { PARTS, shownFields, type AccountFlowState } from './account-flow-model';

	/**
	 * One setting of the sign-up or sign-in flow, drawn from its description in the model: a short
	 * lead, then its fields. Nothing is preselected, so what is shown as chosen is what someone
	 * chose. Dummy: nothing is saved anywhere.
	 */
	interface Props {
		part: string;
		form: AccountFlowState;
	}

	let { part, form = $bindable() }: Props = $props();

	const def = $derived(PARTS[part]);
	const fields = $derived(shownFields(part, form));

	function chosen(key: string): string[] {
		const value = form.values[key];
		return Array.isArray(value) ? value : [];
	}
</script>

<p class="lead">{t(def.lead)}</p>
{#each fields as field (field.key)}
	{#if field.kind === 'text'}
		<TextField
			label={t(field.label)}
			required={field.required}
			bind:value={
				() =>
					typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : '',
				(value) => (form.values[field.key] = value)
			}
		/>
	{:else if field.kind === 'select'}
		<Select
			label={t(field.label)}
			placeholder={t('af.choose')}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
			options={field.options()}
		/>
	{:else}
		<CheckboxGroup
			title={t(field.label)}
			bind:selected={() => chosen(field.key), (values) => (form.values[field.key] = values)}
			options={field.options()}
		/>
		{#if field.required}<p class="checks-hint">{t('af.hint.checksRequired')}</p>{/if}
	{/if}
{/each}
{#if def.note}
	<Callout tone="info">{t(def.note)}</Callout>
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}

	/* Under a group of checkboxes: what is needed of the group as a whole. */
	.checks-hint {
		margin: calc(-1 * var(--space-related)) 0 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
