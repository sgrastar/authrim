<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ClientField from './ClientField.svelte';
	import ConsentStatementsField from './ConsentStatementsField.svelte';
	import FailedSignInsNote from './FailedSignInsNote.svelte';
	import MethodProfileField from './MethodProfileField.svelte';
	import SessionProfileField from './SessionProfileField.svelte';
	import StepConditionsField from './StepConditionsField.svelte';
	import ScreenField from './ScreenField.svelte';
	import UnregisteredField from './UnregisteredField.svelte';
	import {
		partDef,
		shownFields,
		visibleGroups,
		type AccountFlowState,
		type FlowId
	} from './account-flow-model';
	import { exitDestinations, exitKey } from './screen-exits';

	/**
	 * One setting of the sign-up or sign-in flow, drawn from its description in the model: a short
	 * lead, then its fields. Nothing is preselected, so what is shown as chosen is what someone
	 * chose. Dummy: nothing is saved anywhere.
	 */
	interface Props {
		part: string;
		form: AccountFlowState;
		/** The flow the step is in: a screen step then asks where each of its ways out leads. */
		flow?: FlowId;
		/** The flow cannot hold its consent setting (a sign-in built in the Flow editor): shown, not editable. */
		consentUnavailable?: boolean;
	}

	let { part, form = $bindable(), flow, consentUnavailable = false }: Props = $props();

	const def = $derived(partDef(part));
	const fields = $derived(shownFields(part, form));

	/** The step the part is drawn in (its own way out goes anywhere but there). */
	const group = $derived(
		flow ? visibleGroups(flow, form).find((candidate) => candidate.parts.includes(part)) : undefined
	);

	/**
	 * Where each way out of a more screen leads. Not for the first screen: the method is chosen
	 * there, and the flow goes on from it by the method, whatever button was used.
	 */
	function routesFor(fieldKey: string) {
		const of = flow;
		if (!of) return undefined;
		return {
			destinations: (exit: string) => exitDestinations(of, form, group?.id, exit),
			valueOf: (exit: string) => {
				const destination = form.values[exitKey(fieldKey, exit)];
				return typeof destination === 'string' ? destination : '';
			},
			onchange: (exit: string, destination: string) => {
				if (destination) form.values[exitKey(fieldKey, exit)] = destination;
				else delete form.values[exitKey(fieldKey, exit)];
			}
		};
	}

	const EXTRA_SCREEN = /^reg\.extraScreen:(\d+)$/u;
	const SHOWN_TO_SCREEN = /^reg\.extraScreenWhen:(\d+)$/u;

	/**
	 * The screens whose answers a step's "shown to" can compare: the more screens before it in the
	 * sign-up (numbered before it); every more screen, for consent. Not the first sign-up screen:
	 * the Flow keeps the answers of a screen step only, not of the sign-up step that shows it.
	 */
	function answerScreensFor(fieldKey: string): string[] {
		const before = SHOWN_TO_SCREEN.exec(fieldKey);
		const limit = before ? Number(before[1]) : Infinity;
		return Object.entries(form.values).flatMap(([key, value]) => {
			if (typeof value !== 'string' || !value) return [];
			const extra = EXTRA_SCREEN.exec(key);
			return extra && Number(extra[1]) < limit ? [value] : [];
		});
	}

	function chosen(key: string): string[] {
		const value = form.values[key];
		return Array.isArray(value) ? value : [];
	}
</script>

{#if def.lead}<p class="lead">{t(def.lead)}</p>{/if}
{#if def.info === 'failed-sign-ins'}<FailedSignInsNote />{/if}
{#each fields as field (field.key)}
	{#if field.kind === 'unregistered'}
		<UnregisteredField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
			options={field.options()}
		/>
	{:else if field.kind === 'text'}
		<TextRow
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			bind:value={
				() =>
					typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : '',
				(value) => (form.values[field.key] = value)
			}
		/>
	{:else if field.kind === 'profile'}
		<MethodProfileField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
		/>
	{:else if field.kind === 'session-profile'}
		<SessionProfileField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
		/>
	{:else if field.kind === 'consent-statements'}
		<ConsentStatementsField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			value={chosen(field.key)}
			onchange={(value) => (form.values[field.key] = value)}
			unavailable={consentUnavailable}
		/>
	{:else if field.kind === 'step-conditions'}
		<StepConditionsField
			label={t(field.label)}
			hint={field.hint ? t(field.hint) : undefined}
			value={chosen(field.key)}
			onchange={(value) => {
				if (value.length > 0) form.values[field.key] = value;
				else delete form.values[field.key];
			}}
			answerScreens={answerScreensFor(field.key)}
		/>
	{:else if field.kind === 'saml-sp'}
		<ClientField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			mode="saml"
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
		/>
	{:else if field.kind === 'client' || field.kind === 'client-redirect'}
		{@const clientId = field.clientKey ? form.values[field.clientKey] : undefined}
		<ClientField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			mode={field.kind === 'client' ? 'client' : 'redirect'}
			clientId={typeof clientId === 'string' ? clientId : ''}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => {
				if (form.values[field.key] === value) return;
				form.values[field.key] = value;
				// Another client: the redirect URIs chosen for the one before are not its own.
				for (const other of def.fields) {
					if (other.clientKey === field.key) delete form.values[other.key];
				}
			}}
		/>
	{:else if field.kind === 'screen' && field.screenKinds}
		<ScreenField
			label={t(field.label)}
			required={field.required}
			hint={field.hint ? t(field.hint) : undefined}
			screenKinds={field.screenKinds}
			value={typeof form.values[field.key] === 'string' ? (form.values[field.key] as string) : ''}
			onchange={(value) => (form.values[field.key] = value)}
			routes={field.key === 'reg.screen' ? undefined : routesFor(field.key)}
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
			hint={field.hint ? t(field.hint) : field.required ? t('af.hint.checksRequired') : undefined}
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
