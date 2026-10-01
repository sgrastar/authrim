<script lang="ts">
	import FlowCanvas from '../flow/FlowCanvas.svelte';
	import FlowEdge from '../flow/FlowEdge.svelte';
	import FlowEndpoint from '../flow/FlowEndpoint.svelte';
	import FlowScope from '../flow/FlowScope.svelte';
	import FlowSequence from '../flow/FlowSequence.svelte';
	import FlowStep from '../flow/FlowStep.svelte';
	import { sample, type SampleKey } from './sample';

	/**
	 * Storybook demo: a sign-in flow where optional steps can be added and removed. Each "+"
	 * offers only the steps that belong in its gap; the required step cannot be removed.
	 */
	type StepId = 'iat' | 'mapping' | 'consent' | 'role';
	const ORDER: StepId[] = ['iat', 'mapping', 'consent', 'role'];
	const NAME: Record<StepId, SampleKey> = {
		iat: 'stepIat',
		mapping: 'stepMapping',
		consent: 'stepConsent',
		role: 'stepRole'
	};
	const STATE: Record<StepId, 'done' | 'partial' | 'todo' | 'required'> = {
		iat: 'todo',
		mapping: 'done',
		consent: 'partial',
		role: 'required'
	};
	const STATUS = {
		done: 'stDone',
		partial: 'stPartial',
		todo: 'stTodo',
		required: 'stRequired'
	} as const;

	let active = $state<StepId[]>(['mapping', 'role']);
	let current = $state<StepId>('mapping');
</script>

<FlowCanvas label={sample('flowName')} heading={sample('flowName')} detail={sample('flowDetail')}>
	<FlowEndpoint title={sample('slackTitle')} detail={sample('slackDetail')} />
	<FlowEdge length={24} tip={false} />
	<FlowScope label={sample('authrimScope')}>
		<FlowSequence
			order={ORDER}
			visible={active}
			lead={36}
			trail={6}
			menuTitle={sample('flowName')}
			option={(id) => ({ id, label: sample(NAME[id as StepId]) })}
			onadd={(id) => {
				active = [...active, id as StepId];
				current = id as StepId;
			}}
		>
			{#snippet step(id, { exiting })}
				{@const key = id as StepId}
				<FlowStep
					name={sample(NAME[key])}
					status={sample(STATUS[STATE[key]])}
					state={STATE[key]}
					current={current === key}
					{exiting}
					onselect={() => (current = key)}
					onremove={() => {
						active = active.filter((other) => other !== key);
						if (current === key) current = 'role';
					}}
				/>
			{/snippet}
		</FlowSequence>
	</FlowScope>
	<FlowEdge length={14} />
	<FlowEndpoint kind="authrim" title={sample('usersDb')} detail={sample('usersDbDetail')} />
</FlowCanvas>
