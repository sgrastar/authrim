<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import CheckboxGroup from '$lib/ui/patterns/CheckboxGroup.svelte';
	import ListField from '$lib/ui/patterns/ListField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import {
		consentStatements,
		SIGNUP_FLOWS,
		schemaOptions,
		validSchema,
		type ExtrasForm
	} from './connection-model';

	/**
	 * The settings of the steps that process what passes through the flow, as the earlier
	 * service-flow mock defined them: mapping (input and output schemas, mapping sets), additional
	 * input, consent (statements, policies) and role assignment. Dummy copy: the point is where
	 * each setting is, and that a flow can have them or not.
	 */
	interface Props {
		step: string;
		form: ExtrasForm;
		/** The connection is an app or service that Authrim signs people in for (not a provider). */
		outbound: boolean;
	}

	let { step, form = $bindable(), outbound }: Props = $props();

	const options = $derived(schemaOptions(outbound));
	// Nothing is preselected, and a choice this direction does not offer shows as not chosen.
	const input = $derived(validSchema(form.inputSchema, options.inputs));
	const output = $derived(validSchema(form.outputSchema, options.outputs));
</script>

{#if step === 'mapping-schemas'}
	<p class="lead">{t('sf.extra.schemasLead')}</p>
	<Select
		label={t('sf.extra.inputSchema')}
		placeholder={t('sf.extra.chooseSchema')}
		hint={t('sf.extra.noMapping')}
		value={input}
		onchange={(value) => (form.inputSchema = value)}
		options={options.inputs}
	/>
	<Select
		label={t('sf.extra.outputSchema')}
		placeholder={t('sf.extra.chooseSchema')}
		value={output}
		onchange={(value) => (form.outputSchema = value)}
		options={options.outputs}
	/>
{:else if step === 'mapping-sets'}
	<p class="lead">{t('sf.extra.setsLead')}</p>
	<Select
		label={t('sf.row.mappingSet')}
		placeholder={t('sf.set.choose')}
		value={form.mappingSet}
		onchange={(value) => (form.mappingSet = value)}
		hint={t('sf.extra.setHint')}
		options={[
			{ value: 'tenant-default', label: t('sf.set.tenantDefault') },
			{ value: 'staff', label: t('sf.set.staff') },
			{ value: 'minimal', label: t('sf.set.minimal') }
		]}
	/>
{:else if step === 'additional'}
	<p class="lead">
		{t(outbound ? 'sf.extra.additionalLead.service' : 'sf.extra.additionalLead.provider')}
	</p>
	<ListField
		label={t('sf.part.additional')}
		placeholder="department"
		hint={t('sf.extra.additionalHint')}
		addLabel={t('sf.extra.addField')}
		mono
		bind:values={form.additionalFields}
	/>
{:else if step === 'consent-statements'}
	<p class="lead">{t('sf.extra.statementsLead')}</p>
	<CheckboxGroup
		title={t('sf.extra.statementsTitle')}
		bind:selected={form.consentStatements}
		options={consentStatements()}
	/>
{:else if step === 'consent-policies'}
	<p class="lead">{t('sf.extra.policiesLead')}</p>
	<Select
		label={t('sf.extra.whenLabel')}
		placeholder={t('sf.extra.chooseWhen')}
		value={form.consentPolicy}
		onchange={(value) => (form.consentPolicy = value)}
		options={[
			{ value: 'first', label: t('sf.extra.when.first') },
			{ value: 'version', label: t('sf.extra.when.version') },
			{ value: 'always', label: t('sf.extra.when.always') }
		]}
	/>
{:else if step === 'signup-flow'}
	<p class="lead">
		{t(outbound ? 'sf.extra.signupLead.out' : 'sf.extra.signupLead.in')}
	</p>
	<Select
		label={t('sf.extra.signupFlow')}
		placeholder={t('sf.extra.chooseSignup')}
		hint={t('sf.extra.signupHint')}
		value={form.signupFlow}
		onchange={(value) => (form.signupFlow = value)}
		options={SIGNUP_FLOWS}
	/>
{:else if step === 'role'}
	<p class="lead">
		{t(outbound ? 'sf.extra.roleLead.out' : 'sf.extra.roleLead.in')}
	</p>
	<Select
		label={t('sf.extra.roleLabel')}
		placeholder={t('sf.extra.chooseRole')}
		value={form.role}
		onchange={(value) => (form.role = value)}
		options={[
			{ value: 'member', label: t('sf.extra.role.member') },
			{ value: 'editor', label: t('sf.extra.role.editor') },
			{ value: 'admin', label: t('sf.extra.role.admin') }
		]}
	/>
	<Callout tone="info">{t('sf.extra.roleNote')}</Callout>
{/if}

<style>
	.lead {
		margin: 0;
		color: var(--text-secondary);
	}
</style>
