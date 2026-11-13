<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import DurationField from '#lib/ui/primitives/DurationField.svelte';
	import { httpsUrlProblem, redirectUriProblem, type AppType } from './connection-model';
	import { grantAllowed, type RpSettings } from './connection-settings';

	/**
	 * The connection settings of an OpenID Connect app (an OAuth client of Authrim): its public
	 * profile, grants, tokens, logout, security and token exchange. Dummy: nothing is saved.
	 */
	interface Props {
		part: string;
		settings: RpSettings;
		appType: AppType;
	}

	let { part, settings = $bindable(), appType }: Props = $props();

	const ALGS = ['RS256', 'ES256', 'PS256'];
	const ial = $derived([
		{ value: '', label: t('cs.value.noMinimum') },
		{ value: 'IAL1', label: 'IAL1' },
		{ value: 'IAL2', label: 'IAL2' },
		{ value: 'IAL3', label: 'IAL3' }
	]);
	const GRANTS = [
		'authorization_code',
		'refresh_token',
		'client_credentials',
		'device_code',
		'ciba',
		'token_exchange'
	] as const;
	const optionalHttps = (value: string) => (value === '' ? undefined : httpsUrlProblem(value));
</script>

{#if part === 'rp-profile'}
	<TextRow label={t('cs.row.description')} bind:value={settings.description} />
	<TextRow
		label={t('cs.row.logoUri')}
		placeholder="https://app.example.com/logo.png"
		error={optionalHttps(settings.logoUri)}
		bind:value={settings.logoUri}
	/>
	<TextRow
		label={t('cs.row.clientUri')}
		placeholder="https://app.example.com"
		error={optionalHttps(settings.clientUri)}
		bind:value={settings.clientUri}
	/>
	<TextRow
		label={t('cs.row.policyUri')}
		error={optionalHttps(settings.policyUri)}
		bind:value={settings.policyUri}
	/>
	<TextRow
		label={t('cs.row.tosUri')}
		error={optionalHttps(settings.tosUri)}
		bind:value={settings.tosUri}
	/>
	<ListField
		label={t('cs.row.contacts')}
		placeholder="it@example.com"
		addLabel={t('cs.add.contact')}
		bind:values={settings.contacts}
	/>
	<SelectRow
		label={t('cs.row.minimumIal')}
		hint={t('cs.hint.minimumIal')}
		value={settings.minimumIal}
		onchange={(value) => (settings.minimumIal = value)}
		options={ial}
	/>
{:else if part === 'rp-grants'}
	<CheckboxRow
		label={t('cs.row.grantTypes')}
		required
		hint={t('cs.hint.grantTypes')}
		bind:selected={settings.grantTypes}
		options={GRANTS.map((grant) => ({
			value: grant,
			label: t(`cs.grant.${grant}`),
			disabled: !grantAllowed(grant, appType) && !settings.grantTypes.includes(grant)
		}))}
	/>
	{#if settings.grantTypes.some((grant) => !grantAllowed(grant, appType))}
		<Callout tone="warning" live>{t('cs.warn.ccPublic')}</Callout>
	{/if}
	{#if appType === 'spa' && settings.grantTypes.includes('refresh_token')}
		<SelectRow
			label={t('cs.row.browserRefresh')}
			hint={t('cs.hint.browserRefresh')}
			value={settings.browserRefresh}
			onchange={(value) => (settings.browserRefresh = value as RpSettings['browserRefresh'])}
			options={[
				{ value: 'disabled', label: t('cs.browserRefresh.disabled') },
				{ value: 'dpop_bound', label: t('cs.browserRefresh.dpop') }
			]}
		/>
	{/if}
{:else if part === 'rp-tokens'}
	<FieldRow label={t('cs.row.idTokenLifetime')} plain>
		<DurationField
			label={t('cs.row.idTokenLifetime')}
			hideLabel
			min={60}
			max={86400}
			units={['minutes', 'hours']}
			bind:value={settings.idTokenLifetime}
		/>
	</FieldRow>
	<SelectRow
		label={t('cs.row.idTokenAlg')}
		value={settings.idTokenAlg}
		onchange={(value) => (settings.idTokenAlg = value)}
		options={ALGS.map((alg) => ({ value: alg, label: alg }))}
	/>
	<SelectRow
		label={t('cs.row.userinfoAlg')}
		value={settings.userinfoAlg}
		onchange={(value) => (settings.userinfoAlg = value)}
		options={[
			{ value: 'none', label: t('cs.value.unsigned') },
			...ALGS.map((alg) => ({ value: alg, label: alg }))
		]}
	/>
	{#if settings.grantTypes.includes('refresh_token')}
		<ToggleRow
			label={t('cs.row.refreshRotation')}
			description={t('cs.desc.refreshRotation')}
			bind:checked={settings.refreshRotation}
		/>
		<ToggleRow
			label={t('cs.row.refreshSliding')}
			description={t('cs.desc.refreshSliding')}
			bind:checked={settings.refreshSliding}
		/>
		<ToggleRow label={t('cs.row.refreshAbsolute')} bind:checked={settings.refreshAbsolute} />
		{#if settings.refreshAbsolute}
			<FieldRow label={t('cs.row.refreshAbsoluteLifetime')} plain>
				<DurationField
					label={t('cs.row.refreshAbsoluteLifetime')}
					hideLabel
					min={3600}
					units={['hours', 'days']}
					bind:value={settings.refreshAbsoluteLifetime}
				/>
			</FieldRow>
		{/if}
	{:else}
		<Callout tone="info">{t('cs.note.noRefresh')}</Callout>
	{/if}
{:else if part === 'rp-logout'}
	<ListField
		label={t('cs.row.postLogoutUris')}
		hint={t('cs.hint.postLogoutUris')}
		placeholder="https://app.example.com/signed-out"
		addLabel={t('cs.add.uri')}
		mono
		validate={redirectUriProblem}
		bind:values={settings.postLogoutUris}
	/>
	<TextRow
		label={t('cs.row.frontchannelUri')}
		placeholder="https://app.example.com/logout/frontchannel"
		error={optionalHttps(settings.frontchannelUri)}
		bind:value={settings.frontchannelUri}
	/>
	{#if settings.frontchannelUri}
		<ToggleRow
			label={t('cs.row.sendSession')}
			description={t('cs.desc.sendSession')}
			bind:checked={settings.frontchannelSession}
		/>
	{/if}
	<TextRow
		label={t('cs.row.backchannelUri')}
		placeholder="https://app.example.com/logout/backchannel"
		error={optionalHttps(settings.backchannelUri)}
		bind:value={settings.backchannelUri}
	/>
	{#if settings.backchannelUri}
		<ToggleRow
			label={t('cs.row.requireSid')}
			description={t('cs.desc.requireSid')}
			bind:checked={settings.backchannelSession}
		/>
	{/if}
{:else if part === 'rp-security'}
	<SelectRow
		label={t('cs.row.subjectType')}
		hint={t('cs.hint.subjectType')}
		value={settings.subjectType}
		onchange={(value) => (settings.subjectType = value as RpSettings['subjectType'])}
		options={[
			{ value: 'public', label: t('cs.subject.public') },
			{ value: 'pairwise', label: t('cs.subject.pairwise') }
		]}
	/>
	{#if settings.subjectType === 'pairwise'}
		<TextRow
			label={t('cs.row.sectorUri')}
			required
			placeholder="https://app.example.com/sector.json"
			error={settings.sectorUri ? httpsUrlProblem(settings.sectorUri) : undefined}
			bind:value={settings.sectorUri}
		/>
	{/if}
	<ListField
		label={t('cs.row.webOrigins')}
		hint={t('cs.hint.webOrigins')}
		placeholder="https://app.example.com"
		addLabel={t('cs.add.origin')}
		mono
		validate={httpsUrlProblem}
		bind:values={settings.webOrigins}
	/>
	<TextRow
		label={t('cs.row.jwksUri')}
		hint={t('cs.hint.jwksUri')}
		placeholder="https://app.example.com/.well-known/jwks.json"
		error={optionalHttps(settings.jwksUri)}
		bind:value={settings.jwksUri}
	/>
	<ToggleRow
		label={t('cs.row.dpop')}
		description={t('cs.desc.dpop')}
		bind:checked={settings.dpopBound}
	/>
	<ToggleRow
		label={t('cs.row.mtls')}
		description={t('cs.desc.mtls')}
		bind:checked={settings.mtlsBound}
	/>
	<ToggleRow
		label={t('cs.row.encryptedRequest')}
		description={t('cs.desc.encryptedRequest')}
		bind:checked={settings.encryptedRequest}
	/>
	<ToggleRow
		label={t('cs.row.skipConsent')}
		description={t('cs.desc.skipConsent')}
		bind:checked={settings.skipConsent}
	/>
{:else if part === 'rp-exchange'}
	<ToggleRow
		label={t('cs.row.tokenExchange')}
		description={t('cs.desc.tokenExchange')}
		bind:checked={settings.tokenExchange}
	/>
	{#if settings.tokenExchange}
		<SelectRow
			label={t('cs.row.delegationMode')}
			value={settings.delegationMode}
			onchange={(value) => (settings.delegationMode = value as RpSettings['delegationMode'])}
			options={[
				{ value: 'delegation', label: t('cs.delegation.delegation') },
				{ value: 'impersonation', label: t('cs.delegation.impersonation') },
				{ value: 'none', label: t('cs.delegation.none') }
			]}
		/>
		<ListField
			label={t('cs.row.exchangeClients')}
			hint={t('cs.hint.exchangeClients')}
			placeholder="client-id"
			addLabel={t('cs.add.client')}
			mono
			bind:values={settings.exchangeClients}
		/>
	{/if}
	<!-- Kept in view while it is on, so a change of app type can be put right here. -->
	{#if appType === 'web' || settings.clientCredentials}
		{#if appType !== 'web'}
			<Callout tone="warning" live>{t('cs.warn.ccPublic')}</Callout>
		{/if}
		<ToggleRow
			label={t('cs.row.clientCredentials')}
			description={t('cs.desc.clientCredentials')}
			bind:checked={settings.clientCredentials}
		/>
		{#if settings.clientCredentials}
			<ListField
				label={t('cs.row.ccScopes')}
				placeholder="reports:read"
				addLabel={t('cs.add.scope')}
				mono
				bind:values={settings.ccScopes}
			/>
			<TextRow
				label={t('cs.row.ccAudience')}
				placeholder="https://api.example.com"
				bind:value={settings.ccAudience}
			/>
		{/if}
	{:else}
		<Callout tone="info">{t('cs.note.ccWebOnly')}</Callout>
	{/if}
{/if}
