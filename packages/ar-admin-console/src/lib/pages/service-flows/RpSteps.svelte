<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import CheckboxGroup from '$lib/ui/patterns/CheckboxGroup.svelte';
	import ChoiceCards from '$lib/ui/patterns/ChoiceCards.svelte';
	import ListField from '$lib/ui/patterns/ListField.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import Toggle from '$lib/ui/primitives/Toggle.svelte';
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

	function chooseAppType(value: string) {
		const appType = value as AppType;
		form.appType = appType;
		Object.assign(form, defaultsForAppType(appType));
	}
</script>

{#if step === 'rp-app'}
	<TextField label={t('sf.row.name')} hint={t('sf.rp.nameHint')} bind:value={form.name} />
	<ChoiceCards
		label={t('sf.row.appType')}
		columns={3}
		value={form.appType}
		onchange={chooseAppType}
		options={[
			{
				value: 'web',
				label: t(APP_TYPES.web),
				description: t('sf.appType.web.desc'),
				icon: 'globe'
			},
			{
				value: 'spa',
				label: t(APP_TYPES.spa),
				description: t('sf.appType.spa.desc'),
				icon: 'app'
			},
			{
				value: 'native',
				label: t(APP_TYPES.native),
				description: t('sf.appType.native.desc'),
				icon: 'deviceMobile'
			}
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
		bind:shared={form.shared}
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
	<ChoiceCards
		label={t('sf.rp.authLabel')}
		columns={2}
		value={form.authMethod}
		onchange={(value) => (form.authMethod = value)}
		options={[
			{
				value: 'client_secret_basic',
				label: t('sf.rp.auth.basic'),
				description: t('sf.rp.auth.basic.desc'),
				icon: 'key',
				disabled: secretless
			},
			{
				value: 'client_secret_post',
				label: t('sf.rp.auth.post'),
				description: t('sf.rp.auth.post.desc'),
				icon: 'key',
				disabled: secretless
			},
			{
				value: 'private_key_jwt',
				label: t('sf.rp.auth.jwt'),
				description: t('sf.rp.auth.jwt.desc'),
				icon: 'fingerprint',
				disabled: secretless
			},
			{
				value: 'none',
				label: t('sf.rp.auth.none'),
				description: t('sf.rp.auth.none.desc'),
				icon: 'lock',
				disabled: !secretless
			}
		]}
	/>
	{#if secretless}
		<Callout tone="info">{t('sf.rp.pkceOnly')}</Callout>
	{/if}
	<div class="row">
		<Toggle label={t('sf.rp.requirePkce')} bind:checked={form.pkce} disabled={secretless} />
		<span>
			<strong>{t('sf.rp.requirePkce')}</strong>
			<span class="muted">{secretless ? t('sf.rp.pkceAlways') : t('sf.rp.pkceRecommended')}</span>
		</span>
	</div>
	{#if form.authMethod !== 'none'}
		<Callout tone="info">{t('sf.rp.secretOnce')}</Callout>
	{/if}
{:else if step === 'rp-info'}
	<CheckboxGroup
		title={t('sf.rp.scopesTitle')}
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
	<Select
		label={t('sf.rp.userInfo')}
		placeholder={t('sf.set.choose')}
		value={form.mappingSet}
		onchange={(value) => (form.mappingSet = value)}
		hint={t('sf.rp.userInfoHint')}
		options={[
			{ value: 'tenant-default', label: t('sf.set.tenantDefault') },
			{ value: 'library-staff', label: t('sf.set.libraryStaff') },
			{ value: 'none', label: t('sf.set.none') }
		]}
	/>
{/if}

<style>
	.row {
		display: flex;
		gap: var(--space-grid);
		align-items: flex-start;
	}

	.row > span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.muted {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}
</style>
