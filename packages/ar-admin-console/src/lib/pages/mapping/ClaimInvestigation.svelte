<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		AppSummary,
		ClaimExplanation,
		ExplainConsent,
		ExplainedClaim,
		ExplainSurface,
		IdentityMappingClient,
		TestUser
	} from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import DataTable from '$lib/ui/patterns/DataTable.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Badge from '$lib/ui/primitives/Badge.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import RadioGroup from '$lib/ui/primitives/RadioGroup.svelte';
	import Select from '$lib/ui/primitives/Select.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import ChainList from './ChainList.svelte';
	import { label, tierLabel } from './labels';
	import SourceLabel from './SourceLabel.svelte';

	/**
	 * MAP-04: why a claim is missing. For an app and a test user, the API runs the selection and the
	 * release the token endpoint runs and says, stage by stage, what decided: the mapping used
	 * (with its source), whether each item has a value (never the value), what scopes and consent
	 * held back, and what is sent. Each dropped claim carries a fixed reason code and where to fix
	 * it. A set that cannot be used stops issuance (MAP-06), and the page says so first.
	 */
	interface Props {
		client: IdentityMappingClient;
		tenantId: string;
		/** Preselected app and user, and whether to investigate at once (links, stories). */
		clientId?: string;
		userId?: string;
		/** Where the claims go, and the test user's consent, to start with. */
		surface?: ExplainSurface;
		consent?: ExplainConsent;
		autorun?: boolean;
	}

	let {
		client,
		tenantId,
		clientId = '',
		userId = '',
		surface: initialSurface = 'id_token',
		consent: initialConsent = 'all',
		autorun = false
	}: Props = $props();

	let apps = $state<AppSummary[] | null>(null);
	let users = $state<TestUser[]>([]);
	let loadError = $state(false);
	let appId = $state(untrack(() => clientId));
	let user = $state(untrack(() => userId));
	let surface = $state<ExplainSurface>(untrack(() => initialSurface));
	let consent = $state<ExplainConsent>(untrack(() => initialConsent));
	let result = $state<ClaimExplanation | null>(null);
	/** The app and user the result shown was asked for. */
	let resultFor = $state({ app: '', user: '', surface: '', consent: '' });
	let running = $state(false);
	let runError = $state(false);
	/** Each load or investigation counts up; an answer for an older one is dropped. */
	let generation = 0;

	async function load() {
		const mine = ++generation;
		loadError = false;
		apps = null;
		result = null;
		running = false;
		runError = false;
		try {
			const [nextApps, nextUsers] = await Promise.all([
				client.apps(tenantId),
				client.testUsers(tenantId).then((list) => list.test_users)
			]);
			if (mine !== generation) return;
			[apps, users] = [nextApps, nextUsers];
			if (untrack(() => autorun) && appId && user) await investigate();
		} catch {
			if (mine === generation) loadError = true;
		}
	}

	$effect(() => {
		void load();
	});

	async function investigate() {
		const mine = ++generation;
		const asked = { app: appId, user, surface, consent };
		running = true;
		runError = false;
		try {
			const answer = await client.explain(tenantId, {
				client_id: asked.app,
				subject: { kind: 'test_user', id: asked.user },
				surface: asked.surface,
				consent: asked.consent
			});
			if (mine !== generation) return;
			result = answer;
			resultFor = asked;
		} catch {
			if (mine === generation) runError = true;
		} finally {
			if (mine === generation) running = false;
		}
	}

	/** A result for another app or user than the ones chosen now is not shown as theirs. */
	const stale = $derived(
		result !== null &&
			(resultFor.app !== appId ||
				resultFor.user !== user ||
				resultFor.surface !== surface ||
				resultFor.consent !== consent)
	);
	const subjectText = $derived(
		t('mc.ex.resultFor', {
			app: apps?.find((a) => a.client_id === resultFor.app)?.name ?? resultFor.app,
			user: users.find((u) => u.user_id === resultFor.user)?.label ?? resultFor.user
		})
	);

	// Items whose value was read; one decided at sign-in is neither counted as having one nor not.
	const mapped = $derived(
		result?.claims.filter((c) => c.value !== 'not_read' && c.value !== 'not_evaluated') ?? []
	);
	const withValue = $derived(mapped.filter((c) => c.value === 'present'));
	const filtered = $derived(
		result?.claims.filter(
			(c) => c.reason === 'scope_not_granted' || c.reason === 'consent_missing'
		) ?? []
	);
	const sent = $derived(result?.claims.filter((c) => c.released === true) ?? []);
	const notSent = $derived(result?.claims.filter((c) => c.released === false) ?? []);
	const stopped = $derived(result?.outcome.kind === 'stopped' ? result.outcome : null);

	function filterText(claim: ExplainedClaim): string {
		const scope = claim.scope
			? t(claim.scope_granted ? 'mc.ex.scope.granted' : 'mc.ex.scope.missing', {
					scope: claim.scope
				})
			: '';
		return [scope, label('mc.ex.consent.', claim.consent)].filter(Boolean).join(' · ');
	}
</script>

<Page>
	<PageHeader title={t('mc.ex.title')} description={t('mc.ex.desc')} />

	{#if loadError}
		<Callout tone="warning" live>
			{t('mc.loadFailed')}
			<Button variant="secondary" size="sm" onclick={load}>{t('mc.retry')}</Button>
		</Callout>
	{:else if !apps}
		<LoadingState label={t('mc.loading')} />
	{:else}
		<Card title={t('mc.ex.form')}>
			<div class="form">
				<div class="row">
					<Select
						label={t('mc.ex.app')}
						placeholder={t('mc.ro.choose')}
						options={apps.map((a) => ({ value: a.client_id, label: a.name }))}
						bind:value={appId}
					/>
					<Select
						label={t('mc.ex.user')}
						placeholder={t('mc.ro.choose')}
						hint={t('mc.ex.userHint')}
						options={users.map((u) => ({ value: u.user_id, label: u.label }))}
						bind:value={user}
					/>
				</div>
				<div class="row">
					<Select
						label={t('mc.ex.surface')}
						options={[
							{ value: 'id_token', label: t('mc.ex.surface.id_token') },
							{ value: 'userinfo', label: t('mc.ex.surface.userinfo') }
						]}
						value={surface}
						onchange={(value) => (surface = value === 'userinfo' ? 'userinfo' : 'id_token')}
					/>
					<RadioGroup
						label={t('mc.ex.consentChoice')}
						options={[
							{ value: 'all', label: t('mc.ex.consentChoice.all') },
							{ value: 'none', label: t('mc.ex.consentChoice.none') }
						]}
						value={consent}
						onchange={(value) => (consent = value === 'none' ? 'none' : 'all')}
					/>
				</div>
				<div>
					<Button disabled={!appId || !user} loading={running} onclick={investigate}>
						{t('mc.ex.run')}
					</Button>
				</div>
			</div>
		</Card>

		{#if runError}
			<Callout tone="warning" live>{t('mc.actionFailed')}</Callout>
		{:else if !result}
			<p class="muted">{t('mc.ex.prompt')}</p>
		{:else if stale}
			<Callout tone="info">{t('mc.ex.stale')}</Callout>
		{:else}
			<p class="subject">{subjectText}</p>
			{#if stopped && result.selection.kind === 'bound' && (stopped.code === 'set_inactive' || stopped.code === 'set_missing')}
				<Callout tone="warning" live>
					{t('mc.ex.stopped', {
						tier: tierLabel(result.selection.tier),
						set: result.selection.setName ?? result.selection.setId,
						state: label('mc.set.', stopped.code === 'set_missing' ? 'missing' : 'inactive')
					})}
					{t('mc.ex.stopped.fix', { tier: tierLabel(result.selection.tier) })}
				</Callout>
			{:else if stopped}
				<Callout tone="warning" live>
					{t('mc.ex.stoppedOther', { code: stopped.code })}
					{#if stopped.claim}{t('mc.ex.stoppedClaim', { claim: stopped.claim })}{/if}
				</Callout>
			{/if}
			{#if result.warnings.length > 0}
				<Callout tone="info">
					{t('mc.ex.implicit', {
						sets: result.warnings
							.flatMap((w) => w.activations.map((a) => a.setName ?? a.setId))
							.join(', ')
					})}
				</Callout>
			{/if}

			<Card title={t('mc.ex.stage.selection')}>
				<div class="form">
					<SourceLabel selection={result.selection} labelled />
					<ChainList chain={result.chain} selection={result.selection} />
				</div>
			</Card>

			<div class="stages">
				<Card title={t('mc.ex.stage.values')}>
					<p>
						{t('mc.ex.values.summary', { present: withValue.length, total: mapped.length })}
					</p>
				</Card>
				<Card title={t('mc.ex.stage.filter')}>
					<p>{t('mc.ex.filter.summary', { count: filtered.length })}</p>
					<p class="muted">
						{t('mc.ex.filter.scopes', { list: result.scopes.join(' ') })}
					</p>
				</Card>
				<Card title={t('mc.ex.stage.final')}>
					<p>
						{t('mc.ex.final.summary', {
							count: sent.length,
							dropped: notSent.length
						})}
					</p>
				</Card>
			</div>

			<Card title={t('mc.ex.claims')} description={t('mc.ex.masked')} flush>
				<DataTable
					caption={t('mc.ex.claims')}
					columns={[
						{ key: 'claim', label: t('mc.ex.col.claim'), width: '16%' },
						{ key: 'from', label: t('mc.ex.col.from'), width: '16%' },
						{ key: 'value', label: t('mc.ex.col.value'), width: '10%' },
						{ key: 'filter', label: t('mc.ex.col.filter'), width: '24%' },
						{ key: 'result', label: t('mc.ex.col.result') }
					]}
					rows={result.claims}
					rowKey={(claim) => claim.claim}
				>
					{#snippet cell(claim, column)}
						{#if column.key === 'claim'}
							<code>{claim.claim}</code>
						{:else if column.key === 'from'}
							{#if claim.origin === 'standard'}
								<span class="muted">{t('mc.ex.origin.standard')}</span>
							{:else if claim.sources.length > 0}
								<span class="sources">
									{#each claim.sources as source (source)}<code>{source}</code>{/each}
								</span>
							{:else}
								<span class="muted">—</span>
							{/if}
						{:else if column.key === 'value'}
							<span class:warn={claim.value === 'missing' || claim.value === 'empty'}>
								{label('mc.ex.value.', claim.value)}
							</span>
						{:else if column.key === 'filter'}
							<span class="muted">{filterText(claim)}</span>
						{:else}
							<div class="stack">
								{#if claim.released === null}
									<Badge tone="info" dot>{t('mc.ex.value.not_evaluated')}</Badge>
								{:else}
									<Badge tone={claim.released ? 'success' : 'neutral'} dot>
										{claim.released ? t('mc.ex.sent') : t('mc.ex.notSent')}
									</Badge>
								{/if}
								{#if claim.reason}
									<span>{label('mc.ex.reason.', claim.reason)}</span>
									<span class="muted">{label('mc.ex.fix.', claim.reason)}</span>
								{/if}
							</div>
						{/if}
					{/snippet}
				</DataTable>
			</Card>
		{/if}
	{/if}
</Page>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-columns);
	}

	.stages {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: var(--space-grid);
	}

	.stages p {
		margin: 0 0 var(--space-related);
	}

	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
	}

	.muted {
		color: var(--text-secondary);
	}

	.sources {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.subject {
		margin: 0;
		font-weight: var(--fw-semibold);
	}

	.warn {
		color: var(--warning-text);
		font-weight: var(--fw-semibold);
	}
</style>
