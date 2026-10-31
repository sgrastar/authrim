<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import FlowAddPoint, { type FlowOption } from './FlowAddPoint.svelte';
	import FlowEdge from './FlowEdge.svelte';
	import { flowSegments, removedSteps, type FlowSegment } from './flow-sequence';

	/**
	 * The steps of a flow in their fixed order, with a "+" in each gap that has steps to offer
	 * (and only those steps), so a step is always added at its own place. Put it inside a
	 * FlowScope to keep the "+" points within the frame.
	 *
	 * Removing a step: the step fades where it stood while the rest of the diagram stays as it
	 * was, then the gaps around it close into one "+" that offers it again, and the steps below
	 * slide up. Old and new layouts are never mixed on screen.
	 */
	interface Props {
		/** Every step this flow can have, in running order. */
		order: readonly string[];
		/** Steps in use. Their order does not matter; `order` decides it. */
		visible: readonly string[];
		/** Menu entry for a step that can be added. */
		option: (id: string) => FlowOption;
		onadd: (id: string) => void;
		/** Renders one step, normally a FlowStep; pass `exiting` through to it. */
		step: Snippet<[string, { exiting: boolean }]>;
		/** Line length between two steps with nothing to add in between. */
		gap?: number;
		/** Line into the first step when nothing can be added before it (e.g. across a frame). */
		lead?: number;
		/** Line out of the last step when nothing can be added after it; continues outside. */
		trail?: number;
		/** Heading of the "+" menus, usually the flow name. */
		menuTitle?: string;
	}

	let {
		order,
		visible,
		option,
		onadd,
		step,
		gap = 22,
		lead = 0,
		trail = 0,
		menuTitle
	}: Props = $props();

	/** A gap with a "+" leaves room for the point and its caption, as in the flow editor. */
	const ADD_GAP = 120;

	const EXIT_MS = 220;
	const MOVE = { duration: 240, easing: cubicOut };

	type SceneSegment = FlowSegment & { exiting?: boolean };

	const target = $derived(flowSegments(order, visible));
	/** The layout on screen while a removed step plays its exit; null otherwise. */
	let held = $state<SceneSegment[] | null>(null);
	const scene = $derived<SceneSegment[]>(held ?? target);

	let shown: FlowSegment[] = untrack(() => target);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function reducedMotion(): boolean {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	}

	function sync(next: FlowSegment[]) {
		const onScreen: SceneSegment[] = held ?? shown;
		const gone = removedSteps(
			onScreen.filter((segment) => !segment.exiting),
			next
		);
		if (gone.length > 0 && !reducedMotion()) {
			held = onScreen.map((segment) =>
				gone.includes(segment.key) ? { ...segment, exiting: true } : segment
			);
			clearTimeout(timer);
			timer = setTimeout(() => {
				shown = untrack(() => target);
				held = null;
			}, EXIT_MS);
			return;
		}
		// While a step is leaving, other changes wait for the swap so layouts never mix.
		if (!held) shown = next;
	}

	// Before the DOM updates, so the new layout is never painted ahead of the exit.
	$effect.pre(() => {
		const next = target;
		untrack(() => sync(next));
	});

	$effect(() => () => clearTimeout(timer));
</script>

{#each scene as segment, index (segment.key)}
	<div class="seq__item" class:is-held={held !== null} animate:flip={MOVE}>
		{#if segment.kind === 'step'}
			{@render step(segment.id, { exiting: segment.exiting === true })}
		{:else if segment.options.length > 0}
			<FlowEdge length={ADD_GAP}>
				<FlowAddPoint options={segment.options.map(option)} {onadd} title={menuTitle} />
			</FlowEdge>
		{:else if index > 0 && index < scene.length - 1}
			<FlowEdge length={gap} />
		{:else if index === 0 && lead > 0 && scene.length > 1}
			<FlowEdge length={lead} />
		{:else if index === scene.length - 1 && trail > 0 && scene.length > 1}
			<FlowEdge length={trail} tip={false} />
		{/if}
	</div>
{/each}

<style>
	.seq__item {
		display: flex;
		justify-content: center;
		width: 100%;
	}

	/* The old "+" points stay in place during an exit but cannot be used. */
	.seq__item.is-held :global(.add) {
		visibility: hidden;
		pointer-events: none;
	}
</style>
