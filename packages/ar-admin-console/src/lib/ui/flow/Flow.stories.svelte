<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import FlowScope from './FlowScope.svelte';
	import FlowSequence from './FlowSequence.svelte';
	import FlowStepGroup from './FlowStepGroup.svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { sample } from '../stories/sample';
	import FlowDemo from '../stories/FlowDemo.svelte';
	import FlowLoginDemo from '../stories/FlowLoginDemo.svelte';
	import FlowAddPoint from './FlowAddPoint.svelte';
	import FlowCanvas from './FlowCanvas.svelte';
	import FlowEdge from './FlowEdge.svelte';
	import FlowEndpoint from './FlowEndpoint.svelte';
	import FlowStep from './FlowStep.svelte';

	// The props table's main tab (see named()).
	named(FlowCanvas, 'FlowCanvas');

	const { Story } = defineMeta({
		title: 'Patterns/Flow',
		component: FlowCanvas,
		subcomponents: subcomponents({
			FlowSequence,
			FlowStep,
			FlowStepGroup,
			FlowScope,
			FlowEdge,
			FlowAddPoint,
			FlowEndpoint
		}),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Parts of the service-flow diagram, stacked top to bottom on one centre line:\n\n- **FlowCanvas** — the panel and track (`--flow-node-w` + gutters).\n- **FlowEndpoint** — start/end: the external party, Authrim’s own side (`authrim`), or a tenant-owned `locked` endpoint.\n- **FlowEdge** — animated dashed connector, no labels on the line (what the flow speaks goes in the canvas heading); a **FlowAddPoint** can sit on it.\n- **FlowAddPoint** — “+” whose box grows in place into the steps that fit here (the edge grows with it and pushes the diagram down). With nothing to offer it is not shown.\n- **FlowScope** — brackets the steps Authrim runs; its “+” points stay inside the frame.\n- **FlowSequence** — the steps in their fixed order with a “+” only in gaps that have something to offer, and only what belongs in that gap. Removing a step fades it in place, then the gap closes into a “+” that offers it again and the steps below slide up.\n- **FlowStepGroup** — a step made of parts set one by one (heading with the overall status, then each part).\n- **FlowStep** — one step: name and status on two lines (long German names never collide), `required` steps cannot be removed, others show × on hover/focus.'
				}
			}
		}
	});
</script>

<Story
	name="Sign-in flow"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const addLabel = t('flow.add');
		// Only step-up can be added, and only between the two required steps.
		await userEvent.click(canvas.getByRole('button', { name: addLabel }));
		await userEvent.click(await canvas.findByRole('button', { name: sample('stepMfa') }));
		await waitFor(() => expect(canvas.queryByRole('button', { name: addLabel })).toBeNull());
		await expect(canvas.getByRole('button', { current: 'step' })).toHaveTextContent(
			sample('partConditions')
		);
		await userEvent.click(
			canvas.getByRole('button', { name: t('flow.remove', { name: sample('stepMfa') }) })
		);
		await waitFor(() => expect(canvas.getByRole('button', { name: addLabel })).toBeVisible());
	}}
>
	{#snippet template()}<FlowLoginDemo />{/snippet}
</Story>

<Story
	name="Relying party flow"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const addLabel = t('flow.add');
		// One "+" before Mapping (offers IAT) and one between Mapping and Role (offers Consent).
		await expect(canvas.getAllByRole('button', { name: addLabel })).toHaveLength(2);
		await userEvent.click(canvas.getAllByRole('button', { name: addLabel })[1]);
		await userEvent.click(await canvas.findByRole('button', { name: sample('stepConsent') }));
		// Consent sits between Mapping and Role, and that gap has nothing left to offer.
		await waitFor(() =>
			expect(canvas.getByRole('button', { current: 'step' })).toHaveTextContent(
				sample('stepConsent')
			)
		);
		await expect(canvas.getAllByRole('button', { name: addLabel })).toHaveLength(1);
		// Removing it brings the "+" back in its place once the exit has played.
		await userEvent.click(
			canvas.getByRole('button', { name: t('flow.remove', { name: sample('stepConsent') }) })
		);
		await waitFor(() => expect(canvas.getAllByRole('button', { name: addLabel })).toHaveLength(2));
	}}
>
	{#snippet template()}<FlowDemo />{/snippet}
</Story>

<Story name="Step states">
	{#snippet template()}
		<FlowCanvas label={sample('flowName')}>
			<FlowStep name={sample('stepMapping')} status={sample('stDone')} state="done" current />
			<FlowEdge length={18} />
			<FlowStep
				name={sample('stepConsent')}
				status={sample('stPartial')}
				state="partial"
				onremove={() => {}}
			/>
			<FlowEdge length={18} />
			<FlowStep
				name={sample('stepIat')}
				status={sample('stTodo')}
				state="todo"
				onremove={() => {}}
			/>
			<FlowEdge length={18} />
			<FlowStep name={sample('stepToken')} status={sample('stRequired')} state="required" />
		</FlowCanvas>
	{/snippet}
</Story>

<Story name="Endpoints and add point">
	{#snippet template()}
		<FlowCanvas label={sample('flowName')}>
			<FlowEndpoint title={sample('slackTitle')} detail={sample('slackDetail')} />
			<FlowEdge length={60}>
				<FlowAddPoint
					options={[
						{ id: 'iat', label: sample('stepIat'), description: sample('optIatDesc') },
						{ id: 'consent', label: sample('stepConsent') }
					]}
					onadd={() => {}}
				/>
			</FlowEdge>
			<FlowEndpoint kind="authrim" title={sample('usersDb')} detail={sample('usersDbDetail')} />
			<FlowEdge />
			<FlowEndpoint kind="locked" title="Acme Corporation" detail={sample('usersDbDetail')} />
		</FlowCanvas>
	{/snippet}
</Story>
