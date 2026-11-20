<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { provideBusy } from '#lib/ui/busy/busy.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SecretField from '#lib/ui/primitives/SecretField.svelte';
	import FederationCreated from './FederationCreated.svelte';
	import FederationSteps from './FederationSteps.svelte';
	import type { FederationMappingOption } from './federation-model';
	import { emptyFederationForm } from './federation-model';
	import { provideAddAsFederation } from './federation-from-metadata-context';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import {
		opCreateInput,
		idpCreateInput,
		rpCreateInput,
		rpRedirectsReady,
		spCreateInput,
		type CreatedConnection,
		type LiveConnectionCreation
	} from './connection-creation';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import ChoiceCards from '#lib/ui/patterns/ChoiceCards.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Wizard from '#lib/ui/patterns/Wizard.svelte';
	import AccountFlowDetail from './AccountFlowDetail.svelte';
	import AccountFlowStep from './AccountFlowStep.svelte';
	import {
		aboutPart,
		aboutState,
		accountWizardSteps,
		canProceedAccount,
		emptyFlowState,
		initialState,
		FLOWS,
		ACCOUNT_FLOW_IDS,
		isSyncFlow,
		SYNC_FLOW_IDS,
		type FlowId,
		type AccountFlowState
	} from './account-flow-model';
	import ServiceFlowDetail from './ServiceFlowDetail.svelte';
	import {
		canProceed,
		labelOf,
		emptyAnswers,
		isPristine,
		kindProtocol,
		KINDS_OF,
		leaveDialog,
		sampleAnswers,
		stepsFor,
		type Answers,
		type ConnectionKind,
		type Direction
	} from './connection-model';
	import { settingsFromImport } from './connection-settings';
	import InSteps from './InSteps.svelte';
	import RpSteps from './RpSteps.svelte';
	import SpSteps from './SpSteps.svelte';
	import OurDetails from './OurDetails.svelte';

	/**
	 * "Add service flow": the one place a new app, service or provider, or a sign-up or sign-in
	 * flow, starts. It first asks what to add (a connection one way or the other, or how people
	 * sign up and in), then which kind, then only what that kind cannot start without (a sign-up
	 * or sign-in flow: its name and where it is used). "Continue to settings" ends the wizard and opens the connection's service
	 * flow. Without `live`, connections remain local prototype state. `live` restricts the
	 * available protocols and saves through the supplied Admin API callback.
	 *
	 * For a story or the mock app to open part-way, `prefill` fills the answers of a kind
	 * (`filled`: only what the wizard asks, or everything), `prefillAccount` those of a sign-up or
	 * sign-in flow, `step` picks the wizard step and `review` opens the service flow directly.
	 *
	 * Leaving the wizard with answers in it costs them: Cancel asks first, and `dirty` tells the
	 * page when it should do the same for any other way out (a link, a closed tab; see LeaveGuard).
	 */
	interface Props {
		/** Only offer sign-up and sign-in flows (the first live service-flow slice). */
		accountOnly?: boolean;
		/** Explicit real outgoing creation; absent in prototype stories. */
		live?: LiveConnectionCreation;
		prefill?: ConnectionKind;
		/** A metadata address to start a federation from (live only). */
		prefillMetadataUrl?: string;
		/** A sign-up, sign-in or sync flow to open with. */
		prefillAccount?: FlowId;
		filled?: 'wizard' | 'complete';
		step?: number;
		review?: boolean;
		/** Something has been entered that leaving would lose. */
		dirty?: boolean;
		/** The person left the wizard (after being asked, when there was something to lose). */
		oncancel?: () => void;
		/** From the service flow: back to the list of connections. */
		ondone?: () => void;
	}

	let {
		accountOnly = false,
		live,
		prefill,
		prefillMetadataUrl,
		prefillAccount,
		filled = 'wizard',
		step = 0,
		review = false,
		dirty = $bindable(false),
		oncancel,
		ondone
	}: Props = $props();

	// Where it opens is decided once; after that the person's answers are what move it.
	let answers = $state<Answers>(
		untrack(() => {
			const initial = !live && prefill ? sampleAnswers(prefill, filled) : emptyAnswers(!!live);
			if (live) {
				Object.assign(initial.op, {
					scopes: 'openid email profile',
					link: 'manual',
					requireEmailVerified: true,
					trustEmail: false,
					jitProvisioning: false
				});
				initial.idp.certificate = '';
				if (prefillMetadataUrl) initial.federation.metadataUrl = prefillMetadataUrl;
			}
			return initial;
		})
	);
	const initialAnswers = untrack(() => JSON.stringify(answers));
	/** The sign-up or sign-in flow being added, when that is what was chosen. */
	let account = $state<{ flow: FlowId | ''; form: AccountFlowState }>(
		untrack(() =>
			prefillAccount
				? {
						flow: prefillAccount,
						form: isSyncFlow(prefillAccount)
							? aboutState(prefillAccount, 'HR system sync', 'HR system')
							: aboutState(
									prefillAccount,
									prefillAccount === 'registration'
										? 'Partner portal sign-up'
										: 'Partner portal sign-in',
									'other-ui'
								)
					}
				: { flow: '', form: emptyFlowState() }
		)
	);
	/**
	 * What the first question was answered with: a way of connecting, sign-up and sign-in, or
	 * syncing users.
	 */
	let where = $state<string>(
		untrack(() =>
			accountOnly
				? 'account'
				: prefillAccount
					? isSyncFlow(prefillAccount)
						? 'sync'
						: 'account'
					: answers.direction
		)
	);
	/** The answer is a flow defined by a table (sign-up, sign-in, CSV, SCIM), not a connection. */
	const forAccount = $derived(where === 'account' || where === 'sync');
	let current = $state(untrack(() => (accountOnly ? Math.max(0, step - 1) : step)));
	let reviewing = $state(untrack(() => !live && review));
	let serviceName = $state('');
	let pending = $state(false);
	let failure = $state('');
	let created = $state<CreatedConnection | null>(null);
	const deferred = $derived(
		answers.kind === 'rp'
			? answers.rp.skipped || answers.rp.redirectUris.length === 0
			: answers.kind === 'sp'
				? answers.sp.skipped
				: answers.kind === 'idp' && answers.idp.skipped
	);
	provideBusy(() => pending);

	// The mapping sets a federation's roles can be given, read when that step is first reached.
	let mappingSets = $state<FederationMappingOption[]>([]);
	let mappingLoading = $state(false);
	let mappingFailed = $state(false);
	let mappingsLoaded = false;
	async function loadMappingSets() {
		if (!live?.federation) return;
		mappingLoading = true;
		mappingFailed = false;
		try {
			mappingSets = await live.federation.mappingSets();
			mappingsLoaded = true;
		} catch {
			mappingFailed = true;
		} finally {
			mappingLoading = false;
		}
	}

	// A metadata address that is an aggregate is added as a federation instead: the wizard turns
	// into the federation's, with the address already in it.
	provideAddAsFederation(
		untrack(() =>
			live?.federation && live.kinds.includes('federation')
				? (metadataUrl: string) => {
						answers.kind = 'federation';
						answers.federation = {
							...emptyFederationForm(answers.direction),
							metadataUrl
						};
					}
				: undefined
		)
	);

	async function navigateCreated() {
		if (!live || !created || pending) return;
		pending = true;
		failure = '';
		try {
			await tick();
			await live.navigate(created);
		} catch {
			failure = t('sf.create.navigationFailed');
		} finally {
			pending = false;
		}
	}

	async function finish() {
		if (pending || created) return;
		if (!live || forAccount) {
			if (answers.kind === 'idp') settingsFromImport(answers.settings, answers.idp.importMode);
			reviewing = true;
			return;
		}
		pending = true;
		failure = '';
		try {
			created = await live.create(answers, serviceName);
		} catch (error) {
			failure =
				error instanceof StepUpCancelledError
					? t('settings.stepUpCancelled')
					: error instanceof Error
						? error.message
						: t('sf.create.failed');
		} finally {
			pending = false;
		}
		// A federation first shows what its first fetch found; the others open at once.
		if (created && !created.clientSecret && !deferred && created.kind !== 'federation')
			await navigateCreated();
	}

	const steps = $derived(
		accountOnly
			? accountWizardSteps(account.flow).slice(1)
			: forAccount
				? accountWizardSteps(account.flow)
				: live && answers.kind === 'rp'
					? ['where', 'kind', 'rp-app', 'rp-redirect', 'rp-signin'].map((id) => ({
							id,
							label: labelOf(id)
						}))
					: live && answers.kind === 'sp'
						? ['where', 'kind', 'sp-import'].map((id) => ({ id, label: labelOf(id) }))
						: live && answers.kind === 'op'
							? ['where', 'kind', 'op-details'].map((id) => ({ id, label: labelOf(id) }))
							: stepsFor(answers)
	);
	/** Both questions are answered, so the rest of the steps are known. */
	const chosen = $derived(
		forAccount
			? account.flow !== ''
			: !!answers.direction && !!answers.kind && KINDS_OF[answers.direction].includes(answers.kind)
	);
	/** Nothing has been entered yet: leaving costs nothing. */
	const pristine = $derived(
		accountOnly
			? account.flow === '' && Object.keys(account.form.values).length === 0
			: !forAccount && (live ? JSON.stringify(answers) === initialAnswers : isPristine(answers))
	);

	let asking = $state(false);
	$effect(() => {
		dirty = created ? !!created.clientSecret && !pending : !reviewing && !pristine;
	});

	function cancel() {
		if (pending || created) return;
		if (pristine) oncancel?.();
		else asking = true;
	}
	const stepId = $derived(steps[Math.min(current, steps.length - 1)].id);

	$effect(() => {
		// Read once on reaching the step; after a failure only the Retry button asks again.
		if (
			stepId === 'federation-participation' &&
			!mappingsLoaded &&
			!mappingLoading &&
			!mappingFailed
		)
			untrack(() => void loadMappingSets());
	});

	// A kind of flow chosen: the settings that start with a value get it, where nothing is entered
	// yet (what was typed before a kind was chosen again is kept).
	$effect.pre(() => {
		const flow = account.flow;
		if (!flow) return;
		untrack(() => {
			for (const [key, value] of Object.entries(initialState(flow).values)) {
				if (!(key in account.form.values)) account.form.values[key] = value;
			}
		});
	});

	/** A kind that does not go with the new first answer is dropped. */
	function chooseWhere(value: string) {
		if (value === 'account' || value === 'sync') {
			answers.direction = '';
			answers.kind = '';
			// A flow of the other group is dropped, as a kind that does not go is.
			if (account.flow && isSyncFlow(account.flow) !== (value === 'sync')) account.flow = '';
			return;
		}
		const direction = value as Direction;
		answers.direction = direction;
		if (answers.kind && !KINDS_OF[direction].includes(answers.kind)) answers.kind = '';
		// A federation starts with the role that goes with the way chosen; later toggles are the person's.
		answers.federation.spRole = direction === 'out';
		answers.federation.idpRole = direction === 'in';
	}

	function canNext(id: string): boolean {
		if (id === 'where')
			return live
				? where === 'account' ||
						((where === 'out' || where === 'in') &&
							live.kinds.some((kind) => KINDS_OF[where === 'in' ? 'in' : 'out'].includes(kind)))
				: where !== '';
		if (live && !forAccount) {
			if (id === 'kind')
				return (
					!!answers.kind &&
					live.kinds.includes(answers.kind) &&
					!!answers.direction &&
					KINDS_OF[answers.direction].includes(answers.kind)
				);
			if (id === 'rp-redirect') return rpRedirectsReady(answers.rp);
			if (id === 'rp-signin' || id === 'sp-import' || id === 'op-details' || id === 'idp-import') {
				try {
					if (id === 'rp-signin') rpCreateInput(answers.rp);
					else if (id === 'sp-import') spCreateInput(answers, serviceName);
					else if (id === 'op-details') opCreateInput(answers.op);
					else idpCreateInput(answers.idp);
					return true;
				} catch {
					return false;
				}
			}
		}
		return forAccount ? canProceedAccount(id, account.flow, account.form) : canProceed(id, answers);
	}

	// Built when shown, so a change of language reaches the cards too.
	const directions = $derived([
		{
			value: 'out',
			label: t('sf.wizard.out.label'),
			description: t('sf.wizard.out.desc')
		},
		{
			value: 'in',
			label: t('sf.wizard.in.label'),
			description: t('sf.wizard.in.desc')
		},
		{
			value: 'account',
			label: t('af.wizard.account.label'),
			description: t('af.wizard.account.desc')
		},
		{
			value: 'sync',
			label: t('af.wizard.sync.label'),
			description: t('af.wizard.sync.desc')
		}
	]);

	const accountKinds = $derived(
		(where === 'sync' ? SYNC_FLOW_IDS : ACCOUNT_FLOW_IDS).map((flow) => ({
			value: flow,
			label: t(`af.wizard.kind.${flow}.label`),
			description: t(`af.wizard.kind.${flow}.desc`)
		}))
	);

	const kinds = $derived({
		rp: {
			value: 'rp',
			label: t('sf.wizard.kind.rp.label'),
			description: t('sf.wizard.kind.rp.desc'),
			badge: 'RP'
		},
		sp: {
			value: 'sp',
			label: t('sf.wizard.kind.sp.label'),
			description: t('sf.wizard.kind.sp.desc'),
			badge: 'SP'
		},
		op: {
			value: 'op',
			label: t('sf.wizard.kind.op.label'),
			description: t('sf.wizard.kind.op.desc'),
			badge: 'OP'
		},
		idp: {
			value: 'idp',
			label: t('sf.wizard.kind.idp.label'),
			description: t('sf.wizard.kind.idp.desc'),
			badge: 'IdP'
		},
		federation: {
			value: 'federation',
			label: t('sf.wizard.kind.federation.label'),
			description: t('sf.wizard.kind.federation.desc'),
			badge: 'Fed'
		}
	});

	const leave = $derived(leaveDialog());
</script>

{#snippet backToList()}
	<!-- The same way out as Cancel: it asks first when something has been entered. -->
	<BackLink onclick={cancel}>{t('sf.detail.back')}</BackLink>
{/snippet}

{#if created && created.kind === 'federation' && live?.federation}
	<PageHeader title={t('sf.create.saved')} />
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	<FederationCreated
		sourceId={created.id}
		client={live.federation.client}
		onopen={navigateCreated}
		{pending}
	/>
{:else if created}
	<PageHeader title={t('sf.create.saved')} />
	{#if (created.kind === 'sp' && answers.sp.skipped) || (created.kind === 'idp' && answers.idp.skipped)}
		<Callout tone="info" title={t('sf.draft.saved')}>{t('sf.draft.metadataRequired')}</Callout>
	{/if}
	{#if created.kind === 'rp' && deferred}<Callout tone="warning"
			>{t('sf.rp.callbacksMissing')}</Callout
		>{/if}
	{#if created.kind === 'rp'}
		<OurDetails partner="app" items={[{ label: t('sf.row.clientId'), value: created.id }]} />
	{/if}
	{#if created.clientSecret}
		<SecretField label={t('sf.in.clientSecret')} value={created.clientSecret} mode="show" once />
	{/if}
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	<Button onclick={navigateCreated} disabled={pending} loading={pending}
		>{t(deferred ? 'sf.draft.openDetails' : 'sf.wizard.finish')}</Button
	>
{:else if reviewing && forAccount && account.flow}
	<AccountFlowDetail
		flow={account.flow}
		bind:form={account.form}
		onback={ondone}
		focusTitle={!review}
	/>
{:else if reviewing}
	<ServiceFlowDetail bind:answers onback={ondone} focusTitle={!review} />
{:else}
	<PageHeader
		title={t('sf.wizard.title')}
		description={t('sf.wizard.description')}
		back={oncancel ? backToList : undefined}
	/>
	{#if failure}<Callout tone="danger" live>{failure}</Callout>{/if}
	<Wizard
		busy={pending}
		{steps}
		bind:current
		canNext={canNext(stepId)}
		stepsNote={chosen ? undefined : t('sf.wizard.stepsNote')}
		context={chosen && current >= (accountOnly ? 1 : 2)
			? forAccount && account.flow
				? t(FLOWS[account.flow].title)
				: kindProtocol(answers.kind as ConnectionKind)
			: undefined}
		final={chosen ? undefined : false}
		finishLabel={t(live && !forAccount ? 'sf.create.save' : 'sf.wizard.finish')}
		onfinish={finish}
		oncancel={oncancel ? cancel : undefined}
	>
		{#snippet children(stepInfo)}
			{#if stepInfo.id === 'where'}
				<ChoiceCards
					label={t('sf.wizard.whereLabel')}
					hideLabel
					columns={2}
					bind:value={where}
					onchange={chooseWhere}
					options={live
						? directions.filter(
								(option) =>
									option.value === 'account' ||
									(option.value === 'out' &&
										live.kinds.some((kind) => KINDS_OF.out.includes(kind))) ||
									(option.value === 'in' && live.kinds.some((kind) => KINDS_OF.in.includes(kind)))
							)
						: directions}
				/>
			{:else if stepInfo.id === 'kind' && forAccount}
				<ChoiceCards
					label={t('sf.wizard.kindLabel')}
					hideLabel
					columns={where === 'sync' ? 3 : 2}
					bind:value={account.flow}
					options={accountKinds}
				/>
			{:else if stepInfo.id === 'account-about' && account.flow}
				<AccountFlowStep part={aboutPart(account.flow)} bind:form={account.form} />
			{:else if stepInfo.id === 'kind'}
				<ChoiceCards
					label={t('sf.wizard.kindLabel')}
					hideLabel
					columns={2}
					bind:value={answers.kind}
					options={KINDS_OF[answers.direction === 'in' ? 'in' : 'out']
						// The prototype pages have no federation to show; the live wizard offers it when it can be saved.
						.filter((kind) => (live ? live.kinds.includes(kind) : kind !== 'federation'))
						.map((kind) => kinds[kind])}
				/>
			{:else if stepInfo.id.startsWith('federation-')}
				<FederationSteps
					step={stepInfo.id}
					bind:form={answers.federation}
					{mappingSets}
					{mappingFailed}
					{mappingLoading}
					onreloadmappings={loadMappingSets}
					onlyRole={answers.direction === 'in' ? 'idp' : 'sp'}
					readCertificateUrl={live?.federation
						? async (url) => (await live.federation!.client.previewCertificateUrl(url)).certificate
						: undefined}
				/>
			{:else if stepInfo.id.startsWith('rp-')}
				<RpSteps live={!!live} step={stepInfo.id} bind:form={answers.rp} />
			{:else if stepInfo.id.startsWith('sp-')}
				<SpSteps
					previewMetadata={live?.previewMetadata}
					live={!!live}
					bind:serviceName
					step={stepInfo.id}
					bind:form={answers.sp}
				/>
			{:else}
				<InSteps
					previewMetadata={live?.previewMetadata}
					live={!!live}
					discoverOidc={live?.discover}
					step={stepInfo.id}
					bind:op={answers.op}
					bind:idp={answers.idp}
				/>
			{/if}
			{#if live && (stepInfo.id === 'rp-redirect' || stepInfo.id === 'sp-import' || stepInfo.id === 'idp-import')}
				{@const skipped =
					stepInfo.id === 'rp-redirect'
						? answers.rp.skipped
						: stepInfo.id === 'sp-import'
							? answers.sp.skipped
							: answers.idp.skipped}
				<Button
					variant="secondary"
					aria-pressed={skipped === true}
					onclick={() => {
						if (stepInfo.id === 'rp-redirect') answers.rp.skipped = !answers.rp.skipped;
						else if (stepInfo.id === 'sp-import') answers.sp.skipped = !answers.sp.skipped;
						else answers.idp.skipped = !answers.idp.skipped;
					}}>{t(skipped ? 'sf.draft.enterNow' : 'sf.draft.skip')}</Button
				>
				{#if skipped}
					<Callout tone="info"
						>{t(
							stepInfo.id === 'rp-redirect' ? 'sf.rp.callbacksMissing' : 'sf.draft.metadataRequired'
						)}</Callout
					>
				{/if}
			{/if}
		{/snippet}
	</Wizard>
{/if}

<ConfirmDialog
	open={asking}
	title={leave.title}
	body={leave.body}
	confirmLabel={leave.confirm}
	cancelLabel={leave.keep}
	tone="danger"
	onconfirm={() => {
		asking = false;
		oncancel?.();
	}}
	oncancel={() => (asking = false)}
/>
