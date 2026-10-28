<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { ApiError } from '$lib/api/api-error';
	import type { Components, TenantInfo, TenantInfoClient } from '$lib/api/tenant-info';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import CopyButton from '$lib/ui/primitives/CopyButton.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import EndpointList from './EndpointList.svelte';

	/**
	 * What the tenant is: its name, its issuer, which parts of Authrim this environment runs, the
	 * addresses of the screens, the profiles that apply, and the endpoints it gives out. All of it
	 * is read; none is set here (the addresses follow from the environment and the tenant's
	 * domain).
	 */
	interface Props {
		client: TenantInfoClient;
		tenantId: string;
	}

	let { client, tenantId }: Props = $props();

	let info = $state<TenantInfo | null>(null);
	let phase = $state<'loading' | 'ready' | 'forbidden' | 'missing' | 'unavailable' | 'failed'>(
		'loading'
	);
	/** Each load counts up; an answer for an older tenant is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const read = await client.get(tenantId);
			if (mine !== generation) return;
			info = read;
			phase = 'ready';
		} catch (failure) {
			if (mine !== generation) return;
			info = null;
			const status = failure instanceof ApiError ? failure.status : 0;
			phase =
				status === 403
					? 'forbidden'
					: status === 404
						? 'missing'
						: status === 503
							? 'unavailable'
							: 'failed';
		}
	}

	$effect(() => {
		void tenantId;
		void load();
	});

	const PARTS: { key: keyof Components; label: 'loginUi' | 'adminUi' | 'saml' | 'async' | 'vc' }[] =
		[
			{ key: 'loginUi', label: 'loginUi' },
			{ key: 'adminUi', label: 'adminUi' },
			{ key: 'saml', label: 'saml' },
			{ key: 'async', label: 'async' },
			{ key: 'vc', label: 'vc' }
		];

	const addresses = (read: TenantInfo) => [
		{ id: 'login', label: t('tg.url.login'), url: read.loginUrl },
		{ id: 'loginBase', label: t('tg.url.loginBase'), url: read.loginBaseUrl },
		{ id: 'sharedLogin', label: t('tg.url.sharedLogin'), url: read.sharedLoginUrl },
		{ id: 'discover', label: t('tg.url.discover'), url: read.discoverUrl },
		{ id: 'admin', label: t('tg.url.admin'), url: read.adminUrl },
		{ id: 'api', label: t('tg.url.api'), url: read.apiUrl }
	];
</script>

{#if phase === 'loading'}
	<LoadingState label={t('tg.tenant.title')} />
{:else if phase !== 'ready' || !info}
	<Callout tone={phase === 'forbidden' ? 'warning' : 'danger'} live>
		{t(
			phase === 'forbidden'
				? 'tg.forbidden'
				: phase === 'missing'
					? 'tg.notFound'
					: phase === 'unavailable'
						? 'tg.unavailable'
						: 'tg.loadFailed'
		)}
		{#if phase === 'unavailable' || phase === 'failed'}
			<Button size="sm" variant="secondary" onclick={load}>{t('common.retry')}</Button>
		{/if}
	</Callout>
{:else}
	<Card title={t('tg.tenant.title')}>
		<DetailList ruled>
			<DetailItem label={t('tg.tenant.name')}>{info.name}</DetailItem>
			<DetailItem label={t('tg.tenant.id')}>
				<code>{info.tenantId}</code>
				{#snippet end()}
					<CopyButton
						variant="icon"
						text={info!.tenantId}
						label={t('tg.copy', { name: t('tg.tenant.id') })}
					/>
				{/snippet}
			</DetailItem>
			<DetailItem label={t('tg.tenant.issuer')}>
				<code>{info.issuer}</code>
				<span class="hint">{t('tg.tenant.issuerHint')}</span>
				{#snippet end()}
					<CopyButton
						variant="icon"
						text={info!.issuer}
						label={t('tg.copy', { name: t('tg.tenant.issuer') })}
					/>
				{/snippet}
			</DetailItem>
		</DetailList>
	</Card>

	<Card title={t('tg.urls.title')} description={t('tg.urls.desc')}>
		<DetailList ruled>
			{#each addresses(info) as address (address.id)}
				{#if address.url}
					<DetailItem label={address.label}>
						<code>{address.url}</code>
						{#snippet end()}
							<CopyButton
								variant="icon"
								text={address.url!}
								label={t('tg.copy', { name: address.label })}
							/>
						{/snippet}
					</DetailItem>
				{:else}
					<DetailItem label={address.label}>
						<span class="none">{t('tg.url.none')}</span>
					</DetailItem>
				{/if}
			{/each}
		</DetailList>
	</Card>

	<Card title={t('tg.parts.title')} description={t('tg.parts.desc')}>
		<DetailList ruled>
			{#each PARTS as part (part.key)}
				{@const running = info.components[part.key]}
				<DetailItem label={t(`tg.part.${part.label}`)}>
					<Badge tone={running ? 'success' : 'neutral'} dot
						>{t(running ? 'tg.part.on' : 'tg.part.off')}</Badge
					>
				</DetailItem>
			{/each}
		</DetailList>
	</Card>

	<Card title={t('tg.profiles.title')} description={t('tg.profiles.desc')}>
		{#if info.profiles}
			<DetailList ruled>
				{#each [{ id: 'audit', label: t('tg.profile.audit'), choice: info.profiles.audit }, { id: 'residency', label: t('tg.profile.residency'), choice: info.profiles.residency }] as row (row.id)}
					<DetailItem label={row.label}>
						{row.choice.label}
						<Badge>{t(row.choice.inherited ? 'tg.profile.inherited' : 'tg.profile.own')}</Badge>
					</DetailItem>
				{/each}
			</DetailList>
		{:else}
			<Callout tone="warning"
				>{t('tg.profiles.error', { reason: info.profilesError ?? '?' })}</Callout
			>
		{/if}
	</Card>

	<EndpointList groups={info.endpoints} />
{/if}

<style>
	code {
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}

	.hint {
		display: block;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}

	.none {
		color: var(--text-muted);
	}
</style>
