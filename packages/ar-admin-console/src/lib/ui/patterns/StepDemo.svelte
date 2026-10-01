<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import type { Demo, DemoPart } from './step-demos';

	/**
	 * A few seconds of what a mapping step does to a value, on a loop: before, the change
	 * happening, after. Plays any demo from step-demos.ts — parts struck through and folding
	 * away, new ones unfolding, letters turning over one after another, values (chips)
	 * leaving and arriving.
	 *
	 * The stage never changes size: it is sized by the still before and after (drawn invisibly),
	 * and the moving layer sits over them, so nothing below jumps while values come and go.
	 * Each loop starts afresh (a short fade) instead of playing the change backwards.
	 *
	 * With reduced motion it is a still "before → after". The sample is decorative (the step's
	 * description says the same in words), so it is hidden from screen readers.
	 */
	interface Props {
		demo: Demo;
	}

	let { demo }: Props = $props();

	const reduceMotion =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

	let after = $state(false);
	/** Each new loop redraws the moving layer, so nothing plays backwards. */
	let loop = $state(0);

	// Before for a moment, the change, after for a moment; again.
	$effect(() => {
		if (reduceMotion) return;
		let timer: ReturnType<typeof setTimeout>;
		const next = () => {
			after = !after;
			if (!after) loop += 1;
			timer = setTimeout(next, after ? 2600 : 1400);
		};
		timer = setTimeout(next, 1400);
		return () => clearTimeout(timer);
	});

	/** Room a part may take while it folds: generous, as wide characters take two columns. */
	const room = (part: DemoPart) => `${Math.max(part.text.length, part.to?.length ?? 0) * 2 + 1}ch`;
</script>

{#snippet part(p: DemoPart, i: number, done: boolean)}
	{#if p.as === 'swap'}
		{#key done}
			<span class="part part--swap" class:is-turned={done} style:--i={i}
				>{done ? p.to : p.text}</span
			>
		{/key}
	{:else if p.space}
		<span class="part part--space" class:is-gone={done} style:--room={room(p)}
			>{#each [...p.text] as _, s (s)}<i></i>{/each}</span
		>
	{:else}
		<span
			class="part"
			class:part--drop={p.as === 'drop'}
			class:part--add={p.as === 'add'}
			class:is-gone={p.as === 'drop' && done}
			class:is-shown={p.as === 'add' && done}
			style:--room={room(p)}>{p.text}</span
		>
	{/if}
{/snippet}

<!-- A state at rest: only what is there before, or after. -->
{#snippet still(done: boolean)}
	<span class="value" class:value--list={demo.list}>
		{#each demo.chips.filter((c) => (done ? c.as !== 'drop' : c.as !== 'add')) as c, n (n)}
			<span class="chip" class:chip--boxed={demo.list}>
				{#each c.parts.filter((p) => (done ? p.as !== 'drop' : p.as !== 'add')) as p, i (i)}
					{#if p.space}
						<span class="part part--space"
							>{#each [...p.text] as _, s (s)}<i></i>{/each}</span
						>
					{:else}
						<span class="part">{p.as === 'swap' && done ? p.to : p.text}</span>
					{/if}
				{/each}
			</span>
		{/each}
	</span>
{/snippet}

{#snippet value(done: boolean)}
	<span class="value" class:value--list={demo.list}>
		{#each demo.chips as c, n (n)}
			<span
				class="chip"
				class:chip--boxed={demo.list}
				class:chip--drop={c.as === 'drop'}
				class:chip--add={c.as === 'add'}
				class:is-gone={c.as === 'drop' && done}
				class:is-shown={c.as === 'add' && done}
			>
				{#each c.parts as p, i (i)}{@render part(p, i, done)}{/each}
			</span>
		{/each}
	</span>
{/snippet}

<div class="demo" aria-hidden="true">
	{#if reduceMotion}
		<div class="demo__still">
			<span class="demo__tag">{t('map.demo.before')}</span>
			{@render still(false)}
			<span class="demo__tag">{t('map.demo.after')}</span>
			{@render still(true)}
		</div>
	{:else}
		<span class="demo__tag" class:is-after={after}
			>{after ? t('map.demo.after') : t('map.demo.before')}</span
		>
		<div class="demo__stage">
			<div class="demo__rest">{@render still(false)}</div>
			<div class="demo__rest">{@render still(true)}</div>
			{#key loop}
				<div class="demo__live">{@render value(after)}</div>
			{/key}
		</div>
	{/if}
</div>

<style>
	.demo {
		display: grid;
		justify-items: start;
		gap: 8px;
		padding: 14px 16px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
	}

	/* Sized by the two states at rest (invisible); the moving layer is drawn over them. */
	.demo__stage {
		position: relative;
		display: grid;
		justify-self: stretch;
		min-width: 0;
		overflow: hidden;
	}

	.demo__rest {
		grid-area: 1 / 1;
		visibility: hidden;
	}

	.demo__live {
		position: absolute;
		inset: 0;
		animation: demo-in 240ms ease-out both;
	}

	/* While values come and go, they stay on one line (the stage keeps its size). */
	.demo__live .value--list {
		flex-wrap: nowrap;
	}

	@keyframes demo-in {
		from {
			opacity: 0;
		}
	}

	.demo__still {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 6px 10px;
	}

	.demo__tag {
		padding: 1px 8px;
		border-radius: var(--radius-badge);
		background: var(--bg-card);
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		transition:
			color 200ms,
			background-color 200ms;
	}

	.demo__tag.is-after {
		background: color-mix(in srgb, var(--primary) 12%, var(--bg-card));
		color: var(--primary);
	}

	/* One line of text; several values wrap as chips. */
	.value {
		display: inline-flex;
		align-items: center;
		min-height: 1.9em;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		white-space: pre;
		unicode-bidi: isolate;
		direction: ltr;
	}

	.value--list {
		flex-wrap: wrap;
		gap: 6px;
		white-space: normal;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		white-space: pre;
	}

	.chip--boxed {
		padding: 1px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		background: var(--bg-card);
	}

	.part {
		display: inline-block;
		vertical-align: bottom;
	}

	/* Going: struck through, then folds away. */
	.part--drop,
	.chip--drop {
		overflow: hidden;
		max-width: var(--room, 40ch);
		transition:
			max-width 550ms cubic-bezier(0.4, 0, 0.2, 1) 350ms,
			padding 550ms cubic-bezier(0.4, 0, 0.2, 1) 350ms,
			border-width 0ms 900ms,
			opacity 400ms 350ms,
			color 200ms;
	}

	.chip--drop {
		max-width: 40ch;
	}

	.part--drop.is-gone,
	.chip--drop.is-gone {
		max-width: 0;
		color: var(--text-muted);
		text-decoration: line-through;
		opacity: 0;
	}

	.chip--drop.chip--boxed.is-gone {
		padding-inline: 0;
		border-width: 0;
	}

	/* A chip that is not there takes its gap with it (the list's gap is 6px). */
	.value--list .chip--drop,
	.value--list .chip--add {
		transition-property: max-width, padding, border-width, opacity, color, margin;
	}

	.value--list .chip--drop.is-gone,
	.value--list .chip--add:not(.is-shown) {
		margin-inline-end: -6px;
	}

	/* Arriving: unfolds after what goes has gone, in the accent colour. */
	.part--add,
	.chip--add {
		overflow: hidden;
		max-width: 0;
		opacity: 0;
		transition:
			max-width 550ms cubic-bezier(0.4, 0, 0.2, 1) 500ms,
			padding 550ms cubic-bezier(0.4, 0, 0.2, 1) 500ms,
			opacity 400ms 600ms;
	}

	.chip--add.chip--boxed {
		padding-inline: 0;
		border-width: 0;
	}

	.part--add.is-shown,
	.chip--add.is-shown {
		max-width: var(--room, 40ch);
		color: var(--primary);
		opacity: 1;
	}

	.chip--add.is-shown {
		max-width: 40ch;
	}

	.chip--add.chip--boxed.is-shown {
		padding-inline: 8px;
		border-width: 1px;
	}

	/* Spaces as faint dots. */
	.part--space {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		overflow: hidden;
		max-width: var(--room);
		padding-inline: 3px;
		transition:
			max-width 500ms cubic-bezier(0.4, 0, 0.2, 1),
			opacity 300ms,
			padding 500ms;
	}

	.part--space i {
		flex-shrink: 0;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--border-strong);
	}

	.part--space.is-gone {
		max-width: 0;
		padding-inline: 0;
		opacity: 0;
	}

	/* Swapped: turns over into what it becomes, one part after another. */
	.part--swap.is-turned {
		color: var(--primary);
		animation: demo-turn 420ms cubic-bezier(0.3, 0.7, 0.4, 1) both;
		animation-delay: calc(var(--i) * 45ms);
	}

	@keyframes demo-turn {
		0% {
			transform: rotateX(90deg);
			opacity: 0;
		}
		60% {
			transform: rotateX(-15deg);
			opacity: 1;
		}
		100% {
			transform: rotateX(0);
		}
	}
</style>
