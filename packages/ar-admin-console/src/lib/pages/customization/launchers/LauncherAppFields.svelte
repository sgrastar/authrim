<script lang="ts">
	import type { LauncherApplicationType, LauncherOidcClient } from '#lib/api/launchers.js';
	import type { SamlServiceProviderOption } from '#lib/api/saml-providers.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckRow from '#lib/ui/patterns/CheckRow.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import { launchTypeHelp, launchTypeLabel } from './launcher-copy';
	import {
		LIMITS,
		launchTypesFor,
		type LauncherEditorValue,
		type ProblemField
	} from './launcher-model';

	/**
	 * What a launcher opens and how: a plain URL, one of the tenant's OIDC clients or SAML
	 * service providers, then the launch types that application allows and the addresses each
	 * needs. Choosing an application names an unnamed launcher after it and picks its usual
	 * launch type (an OIDC client that can start its own sign-in starts there).
	 */
	interface Props {
		value: LauncherEditorValue;
		clients: readonly LauncherOidcClient[];
		samlProviders: readonly SamlServiceProviderOption[];
		errors: Partial<Record<ProblemField, MessageKey>>;
		disabled?: boolean;
	}

	let { value = $bindable(), clients, samlProviders, errors, disabled = false }: Props = $props();

	const error = (field: ProblemField) => (errors[field] ? t(errors[field]) : undefined);
	const client = $derived(clients.find((entry) => entry.client_id === value.applicationId));

	const typeOptions = $derived(
		(['standalone', 'oidc_client', 'saml_sp'] as const).map((type) => ({
			value: type,
			label: t(`ln.app.${type}` as MessageKey)
		}))
	);
	const clientOptions = $derived([
		...(value.applicationId && value.applicationType === 'oidc_client' && !client
			? [
					{
						value: value.applicationId,
						label: t('ln.field.unavailable', { id: value.applicationId })
					}
				]
			: []),
		...clients.map((entry) => ({
			value: entry.client_id,
			label: entry.initiate_login_uri
				? entry.client_name
				: t('ln.field.noInitiate', { name: entry.client_name })
		}))
	]);
	const spOptions = $derived([
		...(value.applicationId &&
		value.applicationType === 'saml_sp' &&
		!samlProviders.some((provider) => provider.id === value.applicationId)
			? [
					{
						value: value.applicationId,
						label: t('ln.field.unavailable', { id: value.applicationId })
					}
				]
			: []),
		...samlProviders.map((provider) => ({ value: provider.id, label: provider.name }))
	]);
	const launchOptions = $derived(
		launchTypesFor(value.applicationType).map((type) => ({
			value: type,
			label: launchTypeLabel(type),
			description: launchTypeHelp(type),
			disabled: type === 'oidc_third_party_initiated' && !client?.initiate_login_uri
		}))
	);

	function chooseType(next: string) {
		const type = next as LauncherApplicationType;
		if (type === value.applicationType) return;
		value.applicationType = type;
		value.applicationId = '';
		value.deepLinkUrl = '';
		value.launchType = launchTypesFor(type)[0];
	}

	function chooseClient(id: string) {
		const chosen = clients.find((entry) => entry.client_id === id);
		if (!chosen) return;
		value.launchType = chosen.initiate_login_uri ? 'oidc_third_party_initiated' : 'bookmark';
		if (!value.name.trim()) value.name = chosen.client_name;
		if (chosen.logo_uri && value.iconType === 'image' && !value.imageUrl.trim())
			value.imageUrl = chosen.logo_uri;
	}

	function chooseProvider(id: string) {
		const chosen = samlProviders.find((provider) => provider.id === id);
		if (chosen && !value.name.trim()) value.name = chosen.name;
	}

	const thirdParty = $derived(value.launchType === 'oidc_third_party_initiated');
	const spInitiated = $derived(value.launchType === 'saml_sp_initiated');
	const idpInitiated = $derived(value.launchType === 'saml_idp_initiated');
</script>

<Card title={t('ln.card.app')}>
	<RowStack>
		<FieldRow label={t('ln.field.appType')} align="text" plain>
			<RadioGroup
				label={t('ln.field.appType')}
				hideLabel
				orientation="horizontal"
				options={typeOptions}
				field="applicationType"
				{disabled}
				value={value.applicationType}
				onchange={chooseType}
			/>
		</FieldRow>

		{#if value.applicationType === 'oidc_client'}
			<SelectRow
				label={t('ln.field.client')}
				required
				placeholder={t('ln.field.choose')}
				options={clientOptions}
				field="applicationId"
				error={error('applicationId')}
				{disabled}
				bind:value={value.applicationId}
				onchange={chooseClient}
			/>
		{:else if value.applicationType === 'saml_sp'}
			<SelectRow
				label={t('ln.field.sp')}
				required
				placeholder={t('ln.field.choose')}
				options={spOptions}
				field="applicationId"
				error={error('applicationId')}
				{disabled}
				bind:value={value.applicationId}
				onchange={chooseProvider}
			/>
		{/if}

		{#if launchOptions.length > 1}
			<FieldRow label={t('ln.field.launchType')} align="text" plain>
				<RadioGroup
					label={t('ln.field.launchType')}
					hideLabel
					options={launchOptions}
					field="launchType"
					{disabled}
					bind:value={value.launchType}
				/>
				{#if errors.launchType}
					<p class="app-fields__error" role="alert">{t(errors.launchType)}</p>
				{/if}
			</FieldRow>
		{/if}

		{#if thirdParty}
			<TextRow
				label={t('ln.field.clientUrl')}
				info={t('ln.field.clientUrlInfo')}
				type="url"
				value={client?.initiate_login_uri ?? ''}
				readonly
				disabled
			/>
		{:else if !idpInitiated}
			<TextRow
				label={spInitiated ? t('ln.field.spUrl') : t('ln.field.launchUrl')}
				info={spInitiated ? t('ln.field.spUrlInfo') : undefined}
				type="url"
				placeholder="https://"
				required
				maxlength={LIMITS.url}
				field="launchUrl"
				error={error('launchUrl')}
				{disabled}
				bind:value={value.launchUrl}
			/>
		{/if}

		{#if !spInitiated}
			<TextRow
				label={idpInitiated ? t('ln.field.relayState') : t('ln.field.deepLink')}
				info={idpInitiated ? t('ln.field.relayStateInfo') : t('ln.field.deepLinkInfo')}
				hint={idpInitiated ? t('ln.field.relayStateHint') : undefined}
				type="url"
				placeholder="https://"
				maxlength={LIMITS.url}
				field="deepLinkUrl"
				error={error('deepLinkUrl')}
				{disabled}
				bind:value={value.deepLinkUrl}
			/>
		{/if}

		<CheckRow
			label={t('ln.field.opens')}
			text={t('ln.field.newTab')}
			field="openInNewTab"
			{disabled}
			bind:checked={value.openInNewTab}
		/>

		{#if idpInitiated}
			<Callout tone="warning" title={t('ln.field.idpTitle')}>{t('ln.field.idpBody')}</Callout>
		{/if}
	</RowStack>
</Card>

<style>
	.app-fields__error {
		margin: var(--space-related) 0 0;
		color: var(--danger);
		font-size: var(--fs-caption);
	}
</style>
