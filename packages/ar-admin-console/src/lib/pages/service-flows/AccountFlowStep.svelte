<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '$lib/ui/patterns/CheckboxRow.svelte';
	import SelectRow from '$lib/ui/patterns/SelectRow.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
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
		<TextRow
			label={t(field.label)}
			required={field.required}
			bind:value={
				() =>
					typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : '',
				(value) => (form.values[field.key] = value)
			}
		/>
	{:else if field.kind === 'select'}
		<SelectRow
			label={t(field.label)}
			placeholder={t('af.choose')}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
			options={field.options()}
		/>
	{:else}
		<CheckboxRow
			label={t(field.label)}
			required={field.required}
			hint={field.required ? t('af.hint.checksRequired') : undefined}
			bind:selected={() => chosen(field.key), (values) => (form.values[field.key] = values)}
			options={field.options()}
		/>
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
</style>
