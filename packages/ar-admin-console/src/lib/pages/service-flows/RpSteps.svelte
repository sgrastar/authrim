<script lang="ts">
	import { t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import CheckboxRow from '$lib/ui/patterns/CheckboxRow.svelte';
	import ListField from '$lib/ui/patterns/ListField.svelte';
	import SelectRow from '$lib/ui/patterns/SelectRow.svelte';
	import TextRow from '$lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '$lib/ui/patterns/ToggleRow.svelte';
	import OurDetails from './OurDetails.svelte';
	import {
		APP_TYPES,
		defaultsForAppType,
		TENANT_ISSUER,
		redirectUriProblem,
		type AppType,
		type RpForm
	} from './connection-model';

	/**
	 * The parts of an OpenID Connect app (relying party): what the wizard asks (name, app type,
	 * sign-in method) and what only the detail screen does (redirect URIs, user information).
	 * Dummy copy: the point is the order and the parts, not the words.
	 */
	interface Props {
		step: string;
		form: RpForm;
	}

	let { step, form = $bindable() }: Props = $props();

	const secretless = $derived(form.appType !== 'web');

	/** What the chosen way of proving itself means, under the dropdown. */
	const AUTH_DESCRIPTION: Record<string, MessageKey> = {
		client_secret_basic: 'sf.rp.auth.basic.desc',
		client_secret_post: 'sf.rp.auth.post.desc',
		private_key_jwt: 'sf.rp.auth.jwt.desc',
		none: 'sf.rp.auth.none.desc'
	};
	const authDescription = $derived(
		form.authMethod in AUTH_DESCRIPTION ? t(AUTH_DESCRIPTION[form.authMethod]) : undefined
	);

	/** What the chosen kind of app means, under the dropdown. */
	const APP_TYPE_DESCRIPTION: Record<AppType, MessageKey> = {
		web: 'sf.appType.web.desc',
		spa: 'sf.appType.spa.desc',
		native: 'sf.appType.native.desc'
	};
	const appTypeDescription = $derived(t(APP_TYPE_DESCRIPTION[form.appType]));

	function chooseAppType(value: string) {
		const appType = value as AppType;
		form.appType = appType;
		Object.assign(form, defaultsForAppType(appType));
	}
</script>

{#if step === 'rp-app'}
	<TextRow label={t('sf.row.name')} hint={t('sf.rp.nameHint')} bind:value={form.name} />
	<SelectRow
		label={t('sf.row.appType')}
		value={form.appType}
		onchange={chooseAppType}
		hint={appTypeDescription}
		options={[
			{ value: 'web', label: t(APP_TYPES.web) },
			{ value: 'spa', label: t(APP_TYPES.spa) },
			{ value: 'native', label: t(APP_TYPES.native) }
		]}
	/>
{:else if step === 'rp-share'}
	<OurDetails
		items={[
			{ label: t('sf.row.issuer'), value: TENANT_ISSUER },
			{
				label: t('sf.ours.discovery'),
				value: `${TENANT_ISSUER}/.well-known/openid-configuration`
			},
			{ label: t('sf.ours.authorizeUrl'), value: `${TENANT_ISSUER}/authorize` },
			{ label: t('sf.ours.tokenUrl'), value: `${TENANT_ISSUER}/token` },
			{ label: t('sf.ours.keys'), value: `${TENANT_ISSUER}/jwks` }
		]}
		partner="app"
		note={t('sf.rp.issuerNote')}
	/>
{:else if step === 'rp-redirect'}
	<ListField
		label={t('sf.part.rp-redirect')}
		hint={t('sf.rp.redirectHint')}
		placeholder="https://app.example.com/callback"
		addLabel={t('sf.rp.addRedirect')}
		mono
		required
		validate={redirectUriProblem}
		bind:values={form.redirectUris}
	/>
{:else if step === 'rp-signin'}
	<SelectRow
		label={t('sf.rp.authLabel')}
		value={form.authMethod}
		onchange={(value) => (form.authMethod = value)}
		hint={authDescription}
		options={[
			{ value: 'client_secret_basic', label: t('sf.rp.auth.basic'), disabled: secretless },
			{ value: 'client_secret_post', label: t('sf.rp.auth.post'), disabled: secretless },
			{ value: 'private_key_jwt', label: t('sf.rp.auth.jwt'), disabled: secretless },
			{ value: 'none', label: t('sf.rp.auth.none'), disabled: !secretless }
		]}
	/>
	{#if secretless}
		<Callout tone="info">{t('sf.rp.pkceOnly')}</Callout>
	{/if}
	<ToggleRow
		label={t('sf.rp.requirePkce')}
		description={secretless ? t('sf.rp.pkceAlways') : t('sf.rp.pkceRecommended')}
		bind:checked={form.pkce}
		disabled={secretless}
	/>
{:else if step === 'rp-info'}
	<CheckboxRow
		label={t('sf.rp.scopesTitle')}
		bind:selected={form.scopes}
		options={[
			{ value: 'openid', label: 'openid', description: t('sf.rp.scope.openid') },
			{ value: 'profile', label: 'profile', description: t('sf.rp.scope.profile') },
			{ value: 'email', label: 'email', description: t('sf.rp.scope.email') },
			{
				value: 'offline_access',
				label: 'offline_access',
				description: t('sf.rp.scope.offline')
			}
		]}
	/>
	{#if !form.scopes.includes('openid')}
		{@const [before, after] = t('sf.rp.openidRequired').split('{scope}')}
		<Callout tone="warning" live>{before}<code>openid</code>{after}</Callout>
	{/if}
	<SelectRow
		label={t('sf.rp.userInfo')}
		placeholder={t('sf.set.choose')}
		value={form.mappingSet}
		onchange={(value) => (form.mappingSet = value)}
		hint={t('sf.rp.userInfoHint')}
		options={[
			{ value: 'tenant-default', label: t('sf.set.tenantDefault') },
			{ value: 'staff', label: t('sf.set.staff') },
			{ value: 'none', label: t('sf.set.none') }
		]}
	/>
{/if}
