<script lang="ts">
	import FlowCanvas from '../flow/FlowCanvas.svelte';
	import FlowEdge from '../flow/FlowEdge.svelte';
	import FlowEndpoint from '../flow/FlowEndpoint.svelte';
	import FlowScope from '../flow/FlowScope.svelte';
	import FlowSequence from '../flow/FlowSequence.svelte';
	import FlowStepGroup from '../flow/FlowStepGroup.svelte';
	import { sample, type SampleKey } from './sample';

	/**
	 * Storybook demo, after the flow editor mock: the sign-in contract. Authenticating the user
	 * and finishing the sign-in are required; step-up can be added between them.
	 */
	type StepId = 'authn' | 'mfa' | 'session';
	const ORDER: StepId[] = ['authn', 'mfa', 'session'];
	const REQUIRED = new Set<StepId>(['authn', 'session']);
	const NAME: Record<StepId, SampleKey> = {
		authn: 'stepAuthn',
		mfa: 'stepMfa',
		session: 'stepSession'
	};
	const PARTS: Record<StepId, Array<[string, SampleKey]>> = {
		authn: [
			['methods', 'partMethods'],
			['validation', 'partValidation']
		],
		mfa: [['conditions', 'partConditions']],
		session: [
			['session', 'partSession'],
			['return', 'partReturn']
		]
	};

	let active = $state<StepId[]>(['authn', 'session']);
	let current = $state('');
</script>

<FlowCanvas
	label={sample('loginFlow')}
	heading={sample('loginFlow')}
	detail={sample('loginContract')}
>
	<FlowEndpoint title={sample('loginStart')} detail={sample('loginStartDetail')} />
	<FlowEdge length={24} tip={false} />
	<FlowScope label={sample('authrimScope')}>
		<FlowSequence
			order={ORDER}
			visible={active}
			lead={36}
			trail={6}
			menuTitle={sample('loginFlow')}
			option={(id) => ({ id, label: sample(NAME[id as StepId]) })}
			onadd={(id) => {
				active = [...active, id as StepId];
				current = PARTS[id as StepId][0][0];
			}}
		>
			{#snippet step(id, { exiting })}
				{@const key = id as StepId}
				<FlowStepGroup
					name={sample(NAME[key])}
					status={REQUIRED.has(key) ? sample('stRequired') : sample('stTodo')}
					state={REQUIRED.has(key) ? 'required' : 'todo'}
					items={PARTS[key].map(([part, label]) => ({
						id: part,
						label: sample(label),
						status: sample('stTodo')
					}))}
					{current}
					{exiting}
					onselect={(part) => (current = part)}
					onremove={REQUIRED.has(key)
						? undefined
						: () => (active = active.filter((other) => other !== key))}
				/>
			{/snippet}
		</FlowSequence>
	</FlowScope>
	<FlowEdge length={14} />
	<FlowEndpoint title={sample('loginDone')} detail={sample('loginDoneDetail')} />
</FlowCanvas>
