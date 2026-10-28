<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import ChoiceCards from '$lib/ui/patterns/ChoiceCards.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Wizard from '$lib/ui/patterns/Wizard.svelte';
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
	 * "Add connection" in Service flows: the one place a new app, service or provider starts.
	 * It first asks where to connect (which way, then what), then only what that kind cannot
	 * start without. "Continue to settings" ends the wizard and opens the connection's service
	 * flow, where every other setting is reached from the flow. Everything here is dummy: nothing
	 * is sent anywhere, and the words are copy for the mock.
	 *
	 * For a story or the mock app to open part-way, `prefill` fills the answers of a kind
	 * (`filled`: only what the wizard asks, or everything), `step` picks the wizard step and
	 * `review` opens the service flow directly.
	 *
	 * Leaving the wizard with answers in it costs them: Cancel asks first, and `dirty` tells the
	 * page when it should do the same for any other way out (a link, a closed tab; see LeaveGuard).
	 */
	interface Props {
		prefill?: ConnectionKind;
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
	let current = $state(untrack(() => step));
	let reviewing = $state(untrack(() => review));

	const steps = $derived(stepsFor(answers));
	/** Both questions are answered, so the rest of the steps are known. */
	const chosen = $derived(
		!!answers.direction && !!answers.kind && KINDS_OF[answers.direction].includes(answers.kind)
	);

	let asking = $state(false);
	$effect(() => {
		dirty = !reviewing && !isPristine(answers);
	});

	function cancel() {
		if (isPristine(answers)) oncancel?.();
		else asking = true;
	}
	const stepId = $derived(steps[Math.min(current, steps.length - 1)].id);

	/** A kind that does not go with the new direction is dropped. */
	function chooseDirection(value: string) {
		const direction = value as Direction;
		if (answers.kind && !KINDS_OF[direction].includes(answers.kind)) answers.kind = '';
	}

	// Built when shown, so a change of language reaches the cards too.
	const directions = $derived([
		{
			value: 'out',
			label: t('sf.wizard.out.label'),
			description: t('sf.wizard.out.desc'),
			icon: 'arrowOut' as const
		},
		{
			value: 'in',
			label: t('sf.wizard.in.label'),
			description: t('sf.wizard.in.desc'),
			icon: 'arrowIn' as const
		}
	]);

	const kinds = $derived({
		rp: {
			value: 'rp',
			label: t('sf.wizard.kind.rp.label'),
			description: t('sf.wizard.kind.rp.desc'),
			icon: 'app' as const,
			badge: 'RP'
		},
		sp: {
			value: 'sp',
			label: t('sf.wizard.kind.sp.label'),
			description: t('sf.wizard.kind.sp.desc'),
			icon: 'handshake' as const,
			badge: 'SP'
		},
		op: {
			value: 'op',
			label: t('sf.wizard.kind.op.label'),
			description: t('sf.wizard.kind.op.desc'),
			icon: 'key' as const,
			badge: 'OP'
		},
		idp: {
			value: 'idp',
			label: t('sf.wizard.kind.idp.label'),
			description: t('sf.wizard.kind.idp.desc'),
			icon: 'building' as const,
			badge: 'IdP'
		}
	});

	const leave = $derived(leaveDialog());
</script>

{#if reviewing}
	<ServiceFlowDetail bind:answers onback={ondone} focusTitle={!review} />
{:else}
	<PageHeader title={t('sf.wizard.title')} description={t('sf.wizard.description')} />
	<Wizard
		{steps}
		bind:current
		canNext={canProceed(stepId, answers)}
		stepsNote={chosen ? undefined : t('sf.wizard.stepsNote')}
		context={chosen && current >= 2 ? kindProtocol(answers.kind as ConnectionKind) : undefined}
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
					bind:value={answers.direction}
					onchange={chooseDirection}
					options={directions}
				/>
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
