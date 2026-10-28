<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import BackLink from '$lib/ui/primitives/BackLink.svelte';
	import ChoiceCards from '$lib/ui/patterns/ChoiceCards.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Wizard from '$lib/ui/patterns/Wizard.svelte';
	import AccountFlowDetail from './AccountFlowDetail.svelte';
	import AccountFlowStep from './AccountFlowStep.svelte';
	import {
		aboutPart,
		aboutState,
		accountWizardSteps,
		canProceedAccount,
		emptyFlowState,
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
	import InSteps from './InSteps.svelte';
	import RpSteps from './RpSteps.svelte';
	import SpSteps from './SpSteps.svelte';

	/**
	 * "Add service flow": the one place a new app, service or provider, or a sign-up or sign-in
	 * flow, starts. It first asks what to add (a connection one way or the other, or how people
	 * sign up and in), then which kind, then only what that kind cannot start without (a sign-up
	 * or sign-in flow: its name and where it is used). "Continue to settings" ends the wizard and opens the connection's service
	 * flow, where every other setting is reached from the flow. Everything here is dummy: nothing
	 * is sent anywhere, and the words are copy for the mock.
	 *
	 * For a story or the mock app to open part-way, `prefill` fills the answers of a kind
	 * (`filled`: only what the wizard asks, or everything), `prefillAccount` those of a sign-up or
	 * sign-in flow, `step` picks the wizard step and `review` opens the service flow directly.
	 *
	 * Leaving the wizard with answers in it costs them: Cancel asks first, and `dirty` tells the
	 * page when it should do the same for any other way out (a link, a closed tab; see LeaveGuard).
	 */
	interface Props {
		prefill?: ConnectionKind;
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
		prefill,
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
		untrack(() => (prefill ? sampleAnswers(prefill, filled) : emptyAnswers()))
	);
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
			prefillAccount ? (isSyncFlow(prefillAccount) ? 'sync' : 'account') : answers.direction
		)
	);
	/** The answer is a flow defined by a table (sign-up, sign-in, CSV, SCIM), not a connection. */
	const forAccount = $derived(where === 'account' || where === 'sync');
	let current = $state(untrack(() => step));
	let reviewing = $state(untrack(() => review));

	const steps = $derived(forAccount ? accountWizardSteps(account.flow) : stepsFor(answers));
	/** Both questions are answered, so the rest of the steps are known. */
	const chosen = $derived(
		forAccount
			? account.flow !== ''
			: !!answers.direction && !!answers.kind && KINDS_OF[answers.direction].includes(answers.kind)
	);
	/** Nothing has been entered yet: leaving costs nothing. */
	const pristine = $derived(!forAccount && isPristine(answers));

	let asking = $state(false);
	$effect(() => {
		dirty = !reviewing && !pristine;
	});

	function cancel() {
		if (pristine) oncancel?.();
		else asking = true;
	}
	const stepId = $derived(steps[Math.min(current, steps.length - 1)].id);

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
	}

	function canNext(id: string): boolean {
		if (id === 'where') return where !== '';
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
		}
	});

	const leave = $derived(leaveDialog());
</script>

{#snippet backToList()}
	<!-- The same way out as Cancel: it asks first when something has been entered. -->
	<BackLink onclick={cancel}>{t('sf.detail.back')}</BackLink>
{/snippet}

{#if reviewing && forAccount && account.flow}
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
	<Wizard
		{steps}
		bind:current
		canNext={canNext(stepId)}
		stepsNote={chosen ? undefined : t('sf.wizard.stepsNote')}
		context={chosen && current >= 2
			? forAccount && account.flow
				? t(FLOWS[account.flow].title)
				: kindProtocol(answers.kind as ConnectionKind)
			: undefined}
		final={chosen ? undefined : false}
		finishLabel={t('sf.wizard.finish')}
		onfinish={() => (reviewing = true)}
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
					options={directions}
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
					options={KINDS_OF[answers.direction === 'in' ? 'in' : 'out'].map((kind) => kinds[kind])}
				/>
			{:else if stepInfo.id.startsWith('rp-')}
				<RpSteps step={stepInfo.id} bind:form={answers.rp} />
			{:else if stepInfo.id.startsWith('sp-')}
				<SpSteps step={stepInfo.id} bind:form={answers.sp} />
			{:else}
				<InSteps step={stepInfo.id} bind:op={answers.op} bind:idp={answers.idp} />
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
