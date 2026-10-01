<script lang="ts">
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { MessageKey } from '$lib/i18n/messages/ja';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import Button from '../primitives/Button.svelte';
	import ActionMenu from '../primitives/ActionMenu.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import ConditionBuilder from './ConditionBuilder.svelte';
	import KeyValueField, { type KeyValue } from './KeyValueField.svelte';
	import { newGroup, type ConditionField, type ConditionGroup } from './condition-model';
	import type { IconName } from '../icons/icons';
	import PickerDialog, { type PickerGroup, type PickerItem } from './PickerDialog.svelte';
	import StepDemo from './StepDemo.svelte';
	import { DEMOS } from './step-demos';
	import RequiredBadge from '../primitives/RequiredBadge.svelte';
	import TypeBadge from '../primitives/TypeBadge.svelte';
	import SearchField from '../primitives/SearchField.svelte';
	import SegmentedControl from '../primitives/SegmentedControl.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import Select from '../primitives/Select.svelte';
	import SelectMenu, { type MenuOption } from '../primitives/SelectMenu.svelte';
	import { placeBeside } from '../primitives/tip-place';
	import { sameValue } from '../save/draft.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { nextId } from './condition-model';
	import { previewMapping, type SampleValue } from './mapping-preview';
	import {
		TRANSFORMS,
		outputType,
		resultType,
		paramApplies,
		parseCondition,
		parsePairs,
		TRANSFORM_CATEGORIES,
		newStep,
		fixesFor,
		generates,
		mappingProblems,
		transformDef,
		unusedSources,
		type Mapping,
		type MappingField,
		type MappingType,
		type MappingProblem,
		type TransformId,
		type TransformStep
	} from './mapping-model';

	/**
	 * Where each attribute on the receiving side comes from. Every receiving attribute is
	 * listed, one line each, read left to right as the data flows — "mail (lower case) →
	 * email" — so the whole picture, and what is still unset, is visible at once.
	 *   inbound:  the source (an IdP, a directory) on the left → Authrim on the right
	 *   outbound: Authrim on the left → the destination (an RP, an SP) on the right
	 *
	 * Press a line to edit it in place: the source attribute(s), and the transforms drawn as
	 * the way the value goes, each with its settings and a "⋯" menu (run earlier / later,
	 * remove). A problem comes with the fix to apply ("Use the first value"). A filter narrows long lists to what is
	 * unset or needs attention.
	 */
	interface Props {
		label: string;
		sources: readonly MappingField[];
		targets: readonly MappingField[];
		mappings?: Mapping[];
		/** Which way data flows; sets the column names unless given. */
		direction?: 'inbound' | 'outbound';
		/** Column names, e.g. "SAML attribute" (left) and "Authrim attribute" (right). */
		sourceLabel?: string;
		targetLabel?: string;
		invalid?: boolean;
		field?: string;
	}

	let {
		label,
		sources,
		targets,
		mappings = $bindable([]),
		direction = 'inbound',
		sourceLabel = direction === 'outbound' ? t('map.out.source') : t('map.in.source'),
		targetLabel = direction === 'outbound' ? t('map.out.target') : t('map.in.target'),
		invalid = $bindable(false),
		field
	}: Props = $props();

	const uid = $props.id();
	const reduceMotion =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	const busy = useBusy();
	const changes = useChangeMark();
	const report = useInvalidReport();

	let open = $state<string | null>(null);
	let show = $state<'all' | 'unmapped' | 'problems'>('all');
	let query = $state('');

	const mappingFor = (key: string) => mappings.find((m) => m.target === key);
	const problemsFor = (key: string): MappingProblem[] => {
		const mapping = mappingFor(key);
		return mapping ? mappingProblems(mapping, sources, targets) : [];
	};
	const needsAttention = (target: MappingField) =>
		problemsFor(target.key).length > 0 || (!!target.required && !mappingFor(target.key));

	$effect(() => {
		invalid = mappings.some((m) => mappingProblems(m, sources, targets).length > 0);
	});
	$effect(() => report(invalid));

	const done = $derived(targets.filter((f) => mappingFor(f.key)).length);
	const attention = $derived(targets.filter(needsAttention).length);
	const unused = $derived(unusedSources(sources, mappings));
	const shown = $derived(
		targets.filter((target) => {
			const q = query.trim().toLowerCase();
			if (q && !`${target.key} ${target.label ?? ''}`.toLowerCase().includes(q)) return false;
			if (show === 'unmapped') return !mappingFor(target.key);
			if (show === 'problems') return needsAttention(target);
			return true;
		})
	);

	const saved = $derived(field ? (changes.original(field) as Mapping[] | undefined) : undefined);
	const rowChanged = (key: string) => {
		if (!field) return false;
		const before = saved?.find((m) => m.target === key);
		const now = mappingFor(key);
		// Ids are the editor's own; compare what the mapping does.
		const plain = (m: Mapping | undefined) =>
			m && {
				sources: m.sources,
				steps: m.steps.map((step) => ({ transform: step.transform, params: step.params }))
			};
		return !sameValue(plain(before), plain(now));
	};

	const sourceOptions = $derived<MenuOption[]>(
		sources.map((f) => ({
			value: f.key,
			label: f.key,
			badge: f.type,
			mono: true,
			description: f.label
		}))
	);
	/** The steps by group, for the picker; each also found by its id ("regex", "hash"). */
	const CATEGORY_ICONS: Record<string, IconName> = {
		clean: 'brush',
		edit: 'pencil',
		convert: 'translate',
		multi: 'list',
		combine: 'stack',
		generate: 'sparkle',
		identifier: 'fingerprint',
		json: 'braces',
		plugin: 'plug'
	};
	/**
	 * The type that reaches the place a step is being chosen for (the source's, through the
	 * steps before it), so each step in the picker can say what it would give there.
	 */
	const pickingInput = $derived.by(() => {
		const mapping = picking ? mappingFor(picking.key) : undefined;
		if (!picking || !mapping) return 'string';
		const before = picking.index === null ? mapping.steps : mapping.steps.slice(0, picking.index);
		return resultType({ ...mapping, steps: before }, sources) ?? 'string';
	});

	/**
	 * Every type a step can give here: one, or several when a setting decides (a date as ISO
	 * 8601 is a date, as Unix time a number).
	 */
	function outputsOf(id: TransformId, input: MappingType): string[] {
		const base = newStep(id, '').params;
		const found = [outputType(id, input, base)];
		for (const param of transformDef(id).params) {
			for (const option of param.options ?? []) {
				const type = outputType(id, input, { ...base, [param.key]: option });
				if (!found.includes(type)) found.push(type);
			}
		}
		return found;
	}

	const pickerGroups = $derived<PickerGroup[]>(
		TRANSFORM_CATEGORIES.map((category) => ({
			id: category,
			label: t(`map.c.${category}`),
			icon: CATEGORY_ICONS[category],
			empty: category === 'plugin' ? t('map.c.pluginEmpty') : undefined,
			items: TRANSFORMS.filter((def) => def.category === category).map((def) => ({
				value: def.id,
				label: t(`map.t.${def.id}`),
				description: t(`map.d.${def.id}`),
				keywords: def.id.replaceAll('_', ' '),
				badges: outputsOf(def.id, pickingInput)
			}))
		}))
	);

	/** Which line's step is being chosen: a new one (index null) or one to change. */
	let picking = $state<{ key: string; index: number | null } | null>(null);
	const pickingValue = $derived(
		picking && picking.index !== null
			? (mappingFor(picking.key)?.steps[picking.index]?.transform ?? null)
			: null
	);
	// With nothing to work on yet, what fits is a value made by a step.
	const pickingStart = $derived(
		picking && picking.index === null && !mappingFor(picking.key)?.sources.some(Boolean)
			? 'generate'
			: undefined
	);

	/** What a condition can look at: every source attribute, by the condition model's types. */
	const conditionFields = $derived<ConditionField[]>(
		sources.map((f) => ({
			key: f.key,
			label: f.label ? `${f.key} (${f.label})` : f.key,
			type: f.type === 'number' || f.type === 'boolean' || f.type === 'string[]' ? f.type : 'string'
		}))
	);

	/** Every IANA time zone the browser knows (UTC first). */
	const timeZones: { value: string; label: string }[] = (() => {
		const names =
			typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
		return ['UTC', ...names.filter((name) => name !== 'UTC')].map((name) => ({
			value: name,
			label: name
		}));
	})();

	/**
	 * A new step, with a condition started for it when it has one, and a chosen value type set
	 * to suit the receiving attribute (true / false for a boolean).
	 */
	function freshStep(id: string, stepId: string, targetType?: MappingType): TransformStep {
		const step = newStep(id as TransformId, stepId);
		if ('valueType' in step.params) {
			step.params.valueType =
				targetType === 'boolean' ? 'as_boolean' : targetType === 'number' ? 'as_number' : 'as_text';
		}
		for (const param of transformDef(step.transform).params) {
			if (param.condition) step.params[param.key] = JSON.stringify(newGroup(conditionFields));
		}
		return step;
	}

	/** A condition setting for the builder; a broken one starts over. */
	const conditionOf = (text: unknown): ConditionGroup =>
		parseCondition(text) ?? newGroup(conditionFields);

	function choose(id: string) {
		if (!picking) return;
		const { key, index } = picking;
		picking = null;
		const steps = mappingFor(key)?.steps ?? [];
		if (index === null) {
			const step = freshStep(id, nextId('step'), targets.find((f) => f.key === key)?.type);
			setSteps(key, [...steps, step]);
			focusLater(`${uid}-${key}-${step.id}-choice`);
		} else if (steps[index]) {
			changeStep(
				key,
				index,
				freshStep(id, steps[index].id, targets.find((f) => f.key === key)?.type)
			);
			focusLater(`${uid}-${key}-${steps[index].id}-choice`);
		}
	}

	/** A line of help under a setting. */
	const PARAM_HINTS: Record<string, MessageKey> = {
		persistentIdentifierProfileId: 'map.p.profileHint',
		keyMap: 'map.p.keyMapHint',
		path: 'map.p.pathHint',
		pattern: 'map.p.patternHint',
		replacement: 'map.p.replacementHint',
		match: 'map.p.matchHint'
	};

	/** A table setting as the pair list KeyValueField edits, and back. */
	const pairsOf = (text: unknown): KeyValue[] =>
		parsePairs(text).map(([key, value]) => ({ key, value }));
	const pairsText = (list: KeyValue[]) =>
		JSON.stringify(list.map(({ key, value }) => [key, value]));

	function setParam(
		key: string,
		index: number,
		step: TransformStep,
		name: string,
		value: string | boolean
	) {
		changeStep(key, index, { ...step, params: { ...step.params, [name]: value } });
	}

	/** Why a line needs attention: its problems, or a required attribute left unset. */
	function reasons(target: MappingField): string[] {
		const found = problemsFor(target.key).map(message);
		if (target.required && !mappingFor(target.key)) found.push(t('map.x.requiredUnset'));
		return found;
	}

	function showWhy(anchor: Element | null, key: string) {
		const bubble = document.getElementById(`${uid}-${key}-why`);
		if (!anchor || !bubble?.showPopover || bubble.matches(':popover-open')) return;
		bubble.showPopover();
		placeBeside(anchor, bubble);
	}

	function hideWhy(key: string) {
		const bubble = document.getElementById(`${uid}-${key}-why`);
		if (bubble?.matches(':popover-open')) bubble.hidePopover();
	}

	function put(key: string, mapping: Mapping | null) {
		const others = mappings.filter((m) => m.target !== key);
		mappings = mapping ? [...others, mapping] : others;
	}

	function update(key: string, patch: Partial<Mapping>) {
		const current = mappingFor(key);
		const base: Mapping = current ?? {
			id: nextId('map'),
			target: key,
			sources: [''],
			steps: []
		};
		put(key, { ...base, ...patch });
	}

	function setSource(key: string, index: number, value: string) {
		const current = mappingFor(key)?.sources ?? [''];
		update(key, { sources: current.map((v, i) => (i === index ? value : v)) });
	}

	const MAX_SOURCES = 5;

	function setSteps(key: string, steps: TransformStep[]) {
		update(key, { steps });
	}

	/** Focus an element of this editor once the list has redrawn. */
	async function focusLater(id: string) {
		await tick();
		document.getElementById(id)?.focus();
	}

	/** Source order matters: the order values are combined in, the order "first with a value" tries. */
	function moveSource(key: string, index: number, by: -1 | 1) {
		const list = [...(mappingFor(key)?.sources ?? [])];
		const to = index + by;
		if (to < 0 || to >= list.length) return;
		[list[index], list[to]] = [list[to], list[index]];
		update(key, { sources: list });
		// The same button, now on the line the attribute moved to (or its other arrow at an end).
		const edge = (by < 0 && to === 0) || (by > 0 && to === list.length - 1);
		focusLater(
			`${uid}-${key}-src-${to}-${edge ? (by < 0 ? 'down' : 'up') : by < 0 ? 'up' : 'down'}`
		);
	}

	function moveStep(key: string, index: number, by: -1 | 1) {
		const steps = [...(mappingFor(key)?.steps ?? [])];
		const to = index + by;
		if (to < 0 || to >= steps.length) return;
		[steps[index], steps[to]] = [steps[to], steps[index]];
		setSteps(key, steps);
		// A moved element loses focus: give it back to the step's menu button.
		focusLater(`${uid}-${key}-${steps[to].id}-menu`);
	}

	function removeStep(key: string, index: number) {
		setSteps(
			key,
			(mappingFor(key)?.steps ?? []).filter((_, i) => i !== index)
		);
		focusLater(`${uid}-${key}-add`);
	}

	const SLIDE_MS = reduceMotion ? 0 : 180;

	/** Open or close a line. */
	function toggle(key: string) {
		open = open === key ? null : key;
	}

	/** Taking away the only source attribute removes the mapping; back to the closed line. */
	async function unassign(key: string) {
		put(key, null);
		toggle(key);
		await tick();
		document.getElementById(`${uid}-${key}-line`)?.focus();
	}

	function changeStep(key: string, index: number, next: TransformStep) {
		setSteps(
			key,
			(mappingFor(key)?.steps ?? []).map((s, i) => (i === index ? next : s))
		);
	}

	function message(problem: MappingProblem): string {
		switch (problem.kind) {
			case 'noSource':
				return t('map.x.noSource');
			case 'needsCombine':
				return t('map.x.needsCombine');
			case 'combineNeedsMore':
				return t('map.x.combineNeedsMore');
			case 'unknownSource':
				return t('map.x.unknownSource', { key: problem.key });
			case 'badPattern':
				return t('map.x.badPattern', { n: problem.step });
			case 'notNumber':
				return t('map.x.notNumber', { n: problem.step });
			case 'missingParam':
				return t('map.x.missingParam', {
					n: problem.step,
					param: t(`map.p.${problem.param}` as MessageKey)
				});
			case 'manyIntoOne':
				return t('map.x.manyIntoOne');
			case 'typeMismatch':
				return t('map.x.typeMismatch', { from: problem.from, to: problem.to });
		}
	}

	/** Read out receiving side first: "email (Required): from mail, Needs attention". */
	function rowLabel(target: MappingField, mapping: Mapping | undefined, attention: boolean) {
		const name = target.required ? `${target.key} (${t('common.required')})` : target.key;
		const used = mapping?.sources.filter(Boolean) ?? [];
		const text = used.length
			? t('map.rowName', { target: name, source: used.join(' + ') })
			: mapping && generates(mapping)
				? t('map.rowNameMade', { target: name, how: stepsSummary(mapping) })
				: t('map.rowNameUnset', { target: name });
		return attention ? `${text}, ${t('map.filter.problems')}` : text;
	}

	/** "To lower case", "Join values (“,”)": a step and what it is set to. */
	function stepSummary(step: TransformStep): string {
		const name = t(`map.t.${step.transform}`);
		const p = step.params;
		if (step.transform === 'normalize')
			return t(p.mode === 'unicode' ? 'map.s.unicode' : 'map.s.whitespace');
		if (step.transform === 'case')
			return t(
				p.mode === 'upper' ? 'map.s.upper' : p.mode === 'title' ? 'map.s.title' : 'map.s.lower'
			);
		if (step.transform === 'text_to_boolean') return name;
		// A fixed value reads as what goes in ("true を入れる"), not as the step's name.
		if (transformDef(step.transform).generates) {
			const value = String(p.value ?? '');
			return t('map.s.fixed', { value: step.transform === 'constant_text' ? `“${value}”` : value });
		}
		const detail =
			p.delimiter === ' '
				? t('map.space')
				: p.delimiter
					? `“${p.delimiter}”`
					: typeof p.text === 'string' && p.text
						? `“${p.text}”`
						: typeof p.find === 'string' && p.find
							? `“${p.find}”`
							: typeof p.match === 'string' && p.match
								? `“${p.match}”`
								: typeof p.pattern === 'string' && p.pattern
									? `/${p.pattern}/`
									: typeof p.path === 'string' && p.path
										? p.path
										: [p.prefix, p.suffix].filter(Boolean).join(' … ');
		return detail ? t('map.withDetail', { name, detail }) : name;
	}

	/** A sample value as the admin would recognise it. */
	/** What a sample value is, as the badges say it ("true" the text vs true the boolean). */
	function sampleType(value: unknown): string | undefined {
		if (value === null || value === undefined || value === '') return undefined;
		if (Array.isArray(value)) {
			const kinds = value
				.map((item) => typeof item)
				.filter((kind, i, all) => all.indexOf(kind) === i);
			return kinds.length === 1 && kinds[0] !== 'object' ? `${kinds[0]}[]` : 'array';
		}
		return typeof value === 'object' ? 'object' : typeof value;
	}

	function sampleText(sample: SampleValue): { text: string; quiet?: boolean } {
		if (!sample.known) return { text: t('map.sample.atSignIn'), quiet: true };
		const value = sample.value;
		if (value === null || value === undefined) return { text: t('map.sample.none'), quiet: true };
		if (value === '') return { text: t('map.sample.empty'), quiet: true };
		if (Array.isArray(value)) return { text: `[${value.map(String).join(', ')}]` };
		if (typeof value === 'object') {
			const json = JSON.stringify(value);
			return { text: json.length > 80 ? `${json.slice(0, 79)}…` : json };
		}
		return { text: String(value) };
	}

	/** Every step in order: "To lower case → Combine attributes (space)". */
	const stepsSummary = (mapping: Mapping) => mapping.steps.map(stepSummary).join(t('map.stepsSep'));
</script>

<!-- In the picker's preview, under the step's description: a demo, and its settings. -->
{#snippet stepPreview(item: PickerItem)}
	{@const settings = transformDef(item.value as TransformId).params}
	<StepDemo demo={DEMOS[item.value as TransformId]} />
	{#if settings.length}
		<div class="step-settings">
			<p>{t('map.pick.settings')}</p>
			<ul>
				{#each settings as param (param.key)}
					<li>{t(`map.p.${param.key}` as MessageKey)}</li>
				{/each}
			</ul>
		</div>
	{/if}
{/snippet}

{#snippet values(list: SampleValue[])}
	<span class="sample__values">
		{#each list as sample, v (v)}
			{@const shown = sampleText(sample)}
			{#if v > 0}<span class="sample__plus" aria-hidden="true">＋</span>{/if}
			{@const type = sample.known ? sampleType(sample.value) : undefined}
			<span class="sample__v" class:is-quiet={shown.quiet}>{shown.text}</span>
			{#if type}<TypeBadge size="sm">{type}</TypeBadge>{/if}
		{/each}
	</span>
{/snippet}

<section class="mapping" aria-labelledby="{uid}-label">
	<p class="mapping__label" id="{uid}-label">{label}</p>

	<div class="mapping__bar">
		<p class="mapping__count" aria-live="polite">
			{t('map.count', { done, total: targets.length })}
		</p>
		<SegmentedControl
			label={t('map.show')}
			size="sm"
			bind:value={show}
			options={[
				{ value: 'all', label: t('map.filter.all') },
				{ value: 'unmapped', label: `${t('map.filter.unmapped')} ${targets.length - done}` },
				{ value: 'problems', label: `${t('map.filter.problems')} ${attention}` }
			]}
		/>
		{#if targets.length > 8}
			<span class="mapping__search">
				<SearchField label={targetLabel} size="sm" bind:value={query} />
			</span>
		{/if}
	</div>

	<div class="mapping__head" aria-hidden="true">
		<span>{sourceLabel}</span><span class="mapping__head-flow">{t('map.transform')}</span><span
			>{targetLabel}</span
		>
	</div>

	{#if shown.length === 0}
		<p class="mapping__note">{t('map.nothing')}</p>
	{/if}
	<ul class="mapping__list">
		{#each shown as target (target.key)}
			{@const mapping = mappingFor(target.key)}
			{@const problems = problemsFor(target.key)}
			{@const isOpen = open === target.key}
			{@const attentionHere = needsAttention(target)}
			<!-- Set: a source chosen, or a value made by a step (a fixed value). -->
			{@const isSet = !!mapping && (mapping.sources.some(Boolean) || generates(mapping))}
			<li class="mrow" class:is-open={isOpen} class:is-changed={rowChanged(target.key)}>
				<button
					type="button"
					id="{uid}-{target.key}-line"
					class="mrow__summary"
					aria-expanded={isOpen}
					aria-controls="{uid}-{target.key}-source {uid}-{target.key}"
					aria-label={rowLabel(target, mapping, attentionHere)}
					aria-describedby={attentionHere ? `${uid}-${target.key}-why` : undefined}
					onclick={() => toggle(target.key)}
					onfocus={(event) => {
						if (attentionHere && event.currentTarget.matches(':focus-visible'))
							showWhy(event.currentTarget.querySelector('.mrow__warn'), target.key);
					}}
					onblur={() => hideWhy(target.key)}
				>
					<span class="mrow__source">
						{#if !isOpen && isSet && mapping}
							<!-- Each source attribute with its type, as on the receiving side. -->
							{#each mapping.sources.filter(Boolean) as key, k (k)}
								{@const type = sources.find((f) => f.key === key)?.type}
								{#if k > 0}<span class="mrow__plus" aria-hidden="true">+</span>{/if}
								<span class="mrow__name"
									><code>{key}</code>{#if type}<TypeBadge>{type}</TypeBadge>{/if}</span
								>
							{/each}
						{/if}
					</span>
					<!-- One thin line from source to target; a transform sits on it. Dotted while unset. -->
					<span class="mrow__flow" class:is-unset={!isSet}>
						<span class="flow__line" aria-hidden="true"></span>
						{#if isSet && mapping && mapping.steps.length}
							<span class="mrow__transform">{stepsSummary(mapping)}</span>
							<span class="flow__line" aria-hidden="true"></span>
						{/if}
						<svg class="flow__head" viewBox="0 0 6 10" aria-hidden="true" focusable="false"
							><path d="M1 1 L5 5 L1 9" /></svg
						>
					</span>
					<span class="mrow__target" class:is-set={isSet}>
						<code>{target.key}</code>
						<TypeBadge>{target.type}</TypeBadge>
						{#if target.required}<RequiredBadge />{/if}
					</span>
					<span class="mrow__status">
						{#if attentionHere}
							<!-- Hover the sign for the reason; the line's button also reads it out. -->
							<span
								class="mrow__warn"
								role="presentation"
								onpointerenter={(event) => showWhy(event.currentTarget, target.key)}
								onpointerleave={() => hideWhy(target.key)}><Icon name="warning" /></span
							>
							<span class="mrow__why" id="{uid}-{target.key}-why" role="tooltip" popover="manual">
								{#each reasons(target) as reason, r (r)}<span>{reason}</span>{/each}
							</span>
						{/if}
						<span class="mrow__chev" aria-hidden="true"><Icon name="caret" /></span>
					</span>
				</button>
				{#if isOpen}
					<!-- While open, the source is chosen in place: over the line's source cell. -->
					<div
						class="mrow__source-edit"
						transition:slide={{ duration: SLIDE_MS }}
						id="{uid}-{target.key}-source"
					>
						{#each mapping?.sources ?? [''] as source, s (s)}
							<div class="ed__source-line">
								<SelectMenu
									label="{sourceLabel}{(mapping?.sources.length ?? 1) > 1 ? ` ${s + 1}` : ''}"
									hideLabel
									size="sm"
									autoOpen={!mapping}
									placeholder={t('map.pickSource')}
									options={sourceOptions}
									value={source}
									onchange={(key) => setSource(target.key, s, key)}
								/>
								<!-- With one source, taking it away removes the mapping. -->
								{#if mapping && mapping.sources.length > 1}
									{@const name = source || String(s + 1)}
									<IconButton
										icon="arrowUp"
										size="sm"
										id="{uid}-{target.key}-src-{s}-up"
										label={t('map.sourceUp', { name })}
										disabled={busy() || s === 0}
										onclick={() => moveSource(target.key, s, -1)}
									/>
									<IconButton
										icon="arrowDown"
										size="sm"
										id="{uid}-{target.key}-src-{s}-down"
										label={t('map.sourceDown', { name })}
										disabled={busy() || s === mapping.sources.length - 1}
										onclick={() => moveSource(target.key, s, 1)}
									/>
									<IconButton
										icon="close"
										label={t('picker.remove', { name: source || String(s + 1) })}
										disabled={busy()}
										onclick={() =>
											update(target.key, {
												sources: mapping.sources.filter((_, i) => i !== s)
											})}
									/>
								{:else}
									<IconButton
										icon="close"
										label={t('map.unassign')}
										disabled={busy() || !mapping}
										onclick={() => unassign(target.key)}
									/>
								{/if}
							</div>
						{/each}
						{#if mapping && mapping.sources.length < MAX_SOURCES}
							<button
								type="button"
								class="src__add"
								disabled={busy()}
								onclick={() => update(target.key, { sources: [...mapping.sources, ''] })}
								><Icon name="plus" />{t('map.addSource')}</button
							>
						{/if}
					</div>

					<!-- The target again, with its name in words, why it needs attention, and the sample
					     output: what the steps make of the source's sample values (see mapping-preview). -->
					{@const trace = mapping ? previewMapping(mapping, sources) : null}
					<div class="mrow__target-edit" transition:slide={{ duration: SLIDE_MS }}>
						<span class="mrow__target" class:is-set={isSet} aria-hidden="true">
							<code>{target.key}</code>
							<TypeBadge>{target.type}</TypeBadge>
							{#if target.required}<RequiredBadge />{/if}
						</span>
						{#if target.label}<span class="mrow__tlabel">{target.label}</span>{/if}
						{#if target.required && !mapping}
							<!-- About the attribute itself, so under it rather than under the arrow. -->
							<span class="mrow__tnote"><Icon name="warning" />{t('map.x.requiredUnset')}</span>
						{/if}
						{#if trace}
							<div class="sample" role="group" aria-labelledby="{uid}-{target.key}-sample">
								<p class="sample__title" id="{uid}-{target.key}-sample">{t('map.sample.title')}</p>
								<ol class="sample__rows">
									{#if trace.input.length}
										<li>
											<span class="sample__n">{t('map.sample.in')}</span>
											{@render values(trace.input)}
										</li>
									{/if}
									{#each trace.steps as after, i (i)}
										<li>
											<span class="sample__n">{i + 1}</span>
											{@render values(after)}
										</li>
									{/each}
								</ol>
								<p class="sample__out">
									<span class="sample__n">{t('map.sample.out')}</span>
									{@render values([trace.output])}
								</p>
							</div>
						{/if}
					</div>

					<!-- The transforms, drawn as the way the value goes: in from the source on the
					     left, through each step in turn, out to the target on the right. Without
					     steps, "Add a transform" sits on the plain line. What is wrong shows under. -->
					<div
						class="mrow__mid"
						transition:slide={{ duration: SLIDE_MS }}
						id="{uid}-{target.key}"
						role="group"
						aria-label={t('map.editRow', { name: target.key })}
					>
						{#if mapping && mapping.steps.length}
							<div class="chain">
								<ol class="chain__steps">
									{#each mapping.steps as step, index (step.id)}
										{@const def = transformDef(step.transform)}
										{@const n = index + 1}
										{@const last = index === mapping.steps.length - 1}
										<li class="slot" class:is-first={index === 0} class:is-last={last}>
											<span class="bus bus--in" aria-hidden="true"
												><span class="bus__tick"></span></span
											>
											<span class="slot__n" aria-hidden="true">{n}</span>
											<div class="card">
												<div class="card__name">
													<button
														type="button"
														class="step-choice"
														id="{uid}-{target.key}-{step.id}-choice"
														aria-haspopup="dialog"
														aria-label="{t('map.step', { n })}: {t(`map.t.${step.transform}`)}"
														disabled={busy()}
														onclick={() => (picking = { key: target.key, index })}
													>
														<span class="step-choice__label">{t(`map.t.${step.transform}`)}</span>
														<span class="step-choice__caret" aria-hidden="true"
															><Icon name="caret" /></span
														>
													</button>
												</div>
												<div class="card__box">
													<span class="card__menu">
														<ActionMenu
															id="{uid}-{target.key}-{step.id}-menu"
															label={t('map.stepMenu', { n })}
															size="sm"
															framed
															actions={[
																{
																	label: t('map.runEarlier'),
																	icon: 'arrowUp',
																	disabled: index === 0,
																	onselect: () => moveStep(target.key, index, -1)
																},
																{
																	label: t('map.runLater'),
																	icon: 'arrowDown',
																	disabled: last,
																	onselect: () => moveStep(target.key, index, 1)
																},
																{
																	label: t('map.removeStep'),
																	icon: 'trash',
																	danger: true,
																	onselect: () => removeStep(target.key, index)
																}
															]}
														/>
													</span>
													{#each def.params.filter( (param) => paramApplies(param, step.params) ) as param (param.key)}
														{#if param.condition}
															<ConditionBuilder
																label={t(`map.p.${param.key}` as MessageKey)}
																fields={conditionFields}
																maxDepth={2}
																bind:value={
																	() => conditionOf(step.params[param.key]),
																	(group) =>
																		setParam(
																			target.key,
																			index,
																			step,
																			param.key,
																			JSON.stringify(group)
																		)
																}
															/>
														{:else if param.zone}
															<Select
																label={t(`map.p.${param.key}` as MessageKey)}
																size="sm"
																value={String(step.params[param.key] || 'UTC')}
																options={timeZones}
																onchange={(v) => setParam(target.key, index, step, param.key, v)}
															/>
														{:else if param.pairs}
															<KeyValueField
																label={t(`map.p.${param.key}` as MessageKey)}
																keyLabel={t('map.p.entryFrom')}
																valueLabel={t('map.p.entryTo')}
																bind:entries={
																	() => pairsOf(step.params[param.key]),
																	(list) =>
																		setParam(target.key, index, step, param.key, pairsText(list))
																}
															/>
														{:else if param.options}
															<Select
																label={t(`map.p.${param.key}` as MessageKey)}
																size="sm"
																value={String(step.params[param.key] ?? param.options[0])}
																options={param.options.map((o) => ({
																	value: o,
																	label: t(`map.p.${o}` as MessageKey)
																}))}
																onchange={(v) => setParam(target.key, index, step, param.key, v)}
															/>
														{:else if param.flag}
															<Checkbox
																checked={step.params[param.key] === true}
																onchange={(event) =>
																	setParam(
																		target.key,
																		index,
																		step,
																		param.key,
																		event.currentTarget.checked
																	)}>{t(`map.p.${param.key}` as MessageKey)}</Checkbox
															>
														{:else}
															<label class="ed__param">
																<span>{t(`map.p.${param.key}` as MessageKey)}</span>
																{#if param.list || PARAM_HINTS[param.key]}<small
																		class="ed__param-hint"
																		>{t(PARAM_HINTS[param.key] ?? 'map.p.listHint')}</small
																	>{/if}
																<input
																	class:is-code={param.code}
																	dir={param.code ? 'ltr' : undefined}
																	value={String(step.params[param.key] ?? '')}
																	spellcheck="false"
																	autocomplete="off"
																	readonly={busy()}
																	oninput={(event) =>
																		setParam(
																			target.key,
																			index,
																			step,
																			param.key,
																			event.currentTarget.value
																		)}
																/>
															</label>
														{/if}
													{/each}
													{#if last && mapping.steps.length > 1}
														<p class="ed__hint">{t('map.stepsHint')}</p>
													{/if}
												</div>
											</div>
											<span class="bus bus--out" aria-hidden="true"
												><span class="bus__tick"></span>{#if index === 0}<svg
														class="flow__head"
														viewBox="0 0 6 10"
														focusable="false"><path d="M1 1 L5 5 L1 9" /></svg
													>{/if}</span
											>
										</li>
									{/each}
								</ol>
								<!-- The next place a step can go: dotted until used. -->
								<div class="slot is-add">
									<span class="bus bus--in" aria-hidden="true"><span class="bus__tick"></span></span
									>
									<span class="slot__n" aria-hidden="true">{mapping.steps.length + 1}</span>
									<span class="slot__add">
										<button
											type="button"
											class="flow__add"
											id="{uid}-{target.key}-add"
											disabled={busy()}
											aria-haspopup="dialog"
											onclick={() => (picking = { key: target.key, index: null })}
											><Icon name="plus" /><span>{t('map.addStep')}</span></button
										>
										<span class="flow__line" aria-hidden="true"></span>
									</span>
									<span class="bus bus--out" aria-hidden="true"
										><span class="bus__tick"></span></span
									>
								</div>
							</div>
						{:else}
							<div class="mrow__flow mrow__flow-edit" class:is-unset={!isSet}>
								<span class="flow__line" aria-hidden="true"></span>
								<!-- Also with no source: a step can make the value itself (a fixed value). -->
								<button
									type="button"
									class="flow__add"
									id="{uid}-{target.key}-add"
									disabled={busy()}
									aria-haspopup="dialog"
									onclick={() => (picking = { key: target.key, index: null })}
									><Icon name="plus" /><span>{t('map.addStep')}</span></button
								>
								<span class="flow__line" aria-hidden="true"></span>
								<svg class="flow__head" viewBox="0 0 6 10" aria-hidden="true" focusable="false"
									><path d="M1 1 L5 5 L1 9" /></svg
								>
							</div>
						{/if}
						{#each problems as problem, p (p)}
							<div class="mrow__problem" role="status">
								<p><Icon name="warning" />{message(problem)}</p>
								{#if fixesFor(problem).length}
									<div class="mrow__fixes">
										{#each fixesFor(problem) as fix (fix.label)}
											<Button
												size="sm"
												variant="secondary"
												disabled={busy()}
												onclick={() =>
													setSteps(target.key, [
														...(mapping?.steps ?? []),
														{ id: nextId('step'), ...fix.step }
													])}>{t(`map.fix.${fix.label}`)}</Button
											>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if unused.length}
		<p class="mapping__note">
			{t('map.unusedList', { source: sourceLabel, list: unused.map((f) => f.key).join(', ') })}
		</p>
	{/if}

	<PickerDialog
		open={picking !== null}
		title={t('map.pickStep')}
		groups={pickerGroups}
		value={pickingValue}
		startGroup={pickingStart}
		chooseLabel={picking?.index === null ? t('map.pick.add') : t('map.pick.change')}
		currentLabel={t('map.pick.current')}
		preview={stepPreview}
		onchoose={choose}
		oncancel={() => (picking = null)}
	/>
</section>

<style>
	/* Source · steps · target, the steps a little wider; state and toggle at the end.
	   Every line and the heading share the columns, so they stay aligned. */
	.mapping {
		--map-cols: minmax(8rem, 1fr) minmax(11rem, 1.3fr) minmax(8rem, 1fr) 2.5rem;
		--map-gap: 12px;
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.mapping__label {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.mapping__bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
	}

	.mapping__count {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.mapping__search {
		flex: 1 1 12rem;
		max-width: 18rem;
		margin-inline-start: auto;
	}

	/* Attribute ← source, the same columns in the heading and every line. */
	.mapping__head {
		display: grid;
		grid-template-columns: var(--map-cols);
		align-items: center;
		gap: var(--map-gap);
	}

	.mapping__head {
		/* The list's 1px border plus the lines' 12px, so headings sit over their columns. */
		padding-inline: 13px;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.mapping__list {
		margin: 0;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		list-style: none;
	}

	.mrow + .mrow {
		border-top: 1px solid var(--border-subtle);
	}

	.mrow.is-changed {
		background: var(--changed-bg);
	}

	/* The line is a grid of the shared columns; the button spans it (its cells on the same
	   tracks), and an open line's source choice sits over the button's source cell. */
	.mrow {
		display: grid;
		grid-template-columns: var(--map-cols);
		column-gap: var(--map-gap);
		padding-inline: 12px;
	}

	.mrow__summary {
		display: grid;
		grid-column: 1 / -1;
		grid-row: 1;
		grid-template-columns: subgrid;
		align-items: center;
		min-height: var(--control-h-dense);
		margin-inline: -12px;
		padding: 6px 12px;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-body);
		text-align: start;
		cursor: pointer;
	}

	/* Open, the line is being edited, not pressed: no hover face. */
	.mrow:not(.is-open) .mrow__summary:hover {
		background: var(--bg-hover);
	}

	/* Open with several sources, the line grows: keep its parts level with the first one. */
	.mrow.is-open .mrow__summary {
		align-items: start;
		padding-block: 10px;
	}

	.mrow__summary:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	/* Open, the source and the transform are edited over the line's own cells, level with
	   its target: source choices in the first column, the arrow (with "Add a transform") in
	   the second. */
	.mrow__source-edit {
		position: relative;
		z-index: 1;
		display: grid;
		grid-column: 1;
		grid-row: 1;
		align-self: start;
		justify-items: start;
		gap: 4px;
		min-width: 0;
		padding-block: 6px;
	}

	.mrow__source-edit > .ed__source-line {
		justify-self: stretch;
	}

	.mrow__mid {
		position: relative;
		z-index: 1;
		display: grid;
		grid-column: 2;
		grid-row: 1;
		align-self: start;
		gap: 8px;
		min-width: 0;
		padding-block: 6px;
	}

	/* Pressing the bare line still closes it: only the steps, the button and the problems take
	   presses. */
	.mrow__mid {
		pointer-events: none;
	}

	.mrow__mid .flow__add,
	.mrow__mid .chain,
	.mrow__mid .mrow__problem {
		pointer-events: auto;
	}

	.mrow__flow-edit {
		height: var(--control-h-sm);
	}

	.mrow.is-open .mrow__summary .mrow__flow,
	.mrow.is-open .mrow__summary .mrow__target {
		visibility: hidden;
	}

	/* Open, the target column is its own layer, level with the line's (same top padding). */
	.mrow__target-edit {
		position: relative;
		z-index: 1;
		display: grid;
		grid-column: 3;
		grid-row: 1;
		align-content: start;
		align-self: start;
		gap: 4px;
		min-width: 0;
		padding-block: 10px;
		pointer-events: none;
	}

	.mrow__target-edit .sample {
		pointer-events: auto;
	}

	/* The sample output: each step's result in order, then what arrives. */
	.sample {
		display: grid;
		gap: 4px;
		margin-top: 6px;
		padding: 8px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		font-size: var(--fs-caption);
	}

	.sample__title {
		margin: 0 0 2px;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.sample__rows {
		display: grid;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sample__rows li,
	.sample__out {
		display: grid;
		grid-template-columns: 2.5em minmax(0, 1fr);
		align-items: baseline;
		gap: 6px;
		margin: 0;
	}

	.sample__n {
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
	}

	.sample__values {
		min-width: 0;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.sample__v {
		font-family: var(--font-mono);
		unicode-bidi: isolate;
	}

	.sample__v.is-quiet {
		color: var(--text-muted);
		font-family: inherit;
	}

	.sample__plus {
		margin-inline: 4px;
		color: var(--text-muted);
	}

	/* What arrives, set apart: the answer to "what will the app get?" */
	.sample__out {
		margin-top: 2px;
		padding-top: 5px;
		border-top: 1px dashed var(--border);
	}

	.sample__out .sample__values {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	/* Another source attribute: the plus lines up with the text of the choices above. */
	.src__add {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		/* A long label (German) takes more lines in a narrow column instead of spilling. */
		min-height: var(--control-h-sm);
		padding: 2px 8px;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		line-height: var(--lh-snug);
		text-align: start;
		cursor: pointer;
		--icon-size: var(--icon-xs);
	}

	/* A small button sitting on the arrow. */
	.flow__add {
		display: inline-flex;
		flex: 0 1 auto;
		align-items: center;
		gap: 4px;
		min-width: 0;
		height: var(--control-h-xs);
		margin-inline: 6px;
		padding-inline: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		background: var(--bg-card);
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
		cursor: pointer;
		--icon-size: var(--icon-xs);
	}

	.flow__add span {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.src__add:hover:not(:disabled),
	.flow__add:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.flow__add:hover:not(:disabled) {
		border-color: var(--border-strong);
	}

	.src__add:focus-visible,
	.flow__add:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.src__add:disabled,
	.flow__add:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.mrow__target,
	.mrow__source {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		min-width: 0;
	}

	/* A source attribute's name and its type stay together when the line wraps. */
	.mrow__name {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.mrow__plus {
		color: var(--text-muted);
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.95em;
		overflow-wrap: anywhere;
	}

	/* A filled attribute's name stands out; one left empty stays plain. */
	.mrow__target.is-set code {
		font-weight: var(--fw-semibold);
	}

	/* Why the attribute needs attention when nothing fills it, under the attribute. */
	.mrow__tnote {
		display: flex;
		flex-basis: 100%;
		align-items: flex-start;
		gap: 6px;
		color: var(--warning-text);
		font-size: var(--fs-caption);
		font-weight: var(--fw-regular);
		--icon-size: var(--icon-sm);
	}

	.mrow__tnote :global(.icon) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.mapping__head-flow {
		text-align: center;
	}

	/* Source → (transform) → target: a quiet line with a small head, the transform on it. */
	.mrow__flow {
		display: flex;
		align-items: center;
		min-width: 0;
		color: var(--border-strong);
	}

	.flow__line {
		flex: 1;
		min-width: 12px;
		border-top: 1px solid currentColor;
	}

	.is-unset .flow__line {
		border-top-style: dashed;
		opacity: 0.7;
	}

	.flow__head {
		flex-shrink: 0;
		width: 6px;
		height: 10px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.25;
		stroke-linecap: round;
		stroke-linejoin: round;
		/* Points along the reading direction (mirrored in RTL). */
		transform: scaleX(var(--dir));
	}

	.is-unset .flow__head {
		opacity: 0.7;
	}

	/* The transform sits on the line; a long name wraps within its column. */
	.mrow__transform {
		flex: 0 1 auto;
		min-width: 0;
		margin-inline: 6px;
		padding: 1px 8px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		line-height: var(--lh-tight);
		text-align: center;
	}

	.mrow__status {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		color: var(--warning-text);
		--icon-size: var(--icon-sm);
	}

	/* The reason, on hovering the sign (or focusing the line with the keyboard). */
	.mrow__warn {
		display: inline-flex;
		cursor: help;
	}

	.mrow__why {
		position: fixed;
		inset: auto;
		display: none;
		max-width: 280px;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-regular);
		line-height: var(--lh-snug);
		text-align: start;
		white-space: normal;
		/* Inside the line's button: pressing it must not press the line. */
		pointer-events: none;
	}

	.mrow__why:popover-open {
		display: grid;
		gap: 4px;
	}

	.mrow__chev {
		display: flex;
		color: var(--text-muted);
		transition: rotate 150ms ease;
		--icon-size: var(--icon-xs);
	}

	.is-open .mrow__chev {
		rotate: 180deg;
	}

	.ed__source-line {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.ed__source-line > :global(:first-child) {
		flex: 1;
		min-width: 0;
	}

	.ed__param {
		display: grid;
		gap: 5px;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.ed__param input {
		width: 100%;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		font-weight: var(--fw-regular);
	}

	.ed__param input.is-code {
		font-family: var(--font-mono);
	}

	.ed__param input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	/* The transforms as a way through: the source line comes in at the top and runs down a
	   bus on the start side, each numbered step branches off it, and a bus on the end side
	   gathers them into the arrow to the target. The next free place (Add a transform) is
	   dotted. Lines sit level with each step's name (half a small control down). */
	.chain {
		--tick-y: calc(var(--control-h-sm) / 2);
		display: grid;
		min-width: 0;
		color: var(--border-strong);
	}

	.chain__steps {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.slot {
		display: grid;
		grid-template-columns: 14px 1.5em minmax(0, 1fr) 22px;
		align-items: start;
		min-width: 0;
	}

	.slot__n {
		display: flex;
		align-items: center;
		justify-content: center;
		height: var(--control-h-sm);
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-variant-numeric: tabular-nums;
	}

	.bus {
		position: relative;
		align-self: stretch;
	}

	.bus::before,
	.bus::after {
		position: absolute;
		border-inline-start: 1px solid currentColor;
		content: '';
	}

	/* Above and below the step's own line. */
	.bus::before {
		top: 0;
		height: var(--tick-y);
	}

	.bus::after {
		top: var(--tick-y);
		bottom: 0;
	}

	.bus--in::before,
	.bus--in::after {
		inset-inline-start: 6px;
	}

	.bus--out::before,
	.bus--out::after {
		inset-inline-start: 10px;
	}

	.bus__tick {
		position: absolute;
		top: var(--tick-y);
		border-top: 1px solid currentColor;
	}

	.bus--in .bus__tick {
		inset-inline: 6px 0;
	}

	.bus--out .bus__tick {
		inset-inline: 0 calc(100% - 11px);
	}

	/* The first step carries the line itself: in from the source, out to the target. */
	.is-first .bus--in .bus__tick {
		inset-inline-start: 0;
	}

	.is-first .bus--out .bus__tick {
		inset-inline-end: 1px;
	}

	.bus .flow__head {
		position: absolute;
		top: calc(var(--tick-y) - 5px);
		inset-inline-end: 0;
	}

	.is-first .bus::before,
	.is-add .bus::after {
		display: none;
	}

	/* Towards the free place: dotted. */
	.is-last .bus::after,
	.is-add .bus::before {
		border-inline-start-style: dashed;
		opacity: 0.7;
	}

	.is-add .bus__tick {
		border-top-style: dashed;
		opacity: 0.7;
	}

	/* A step: its name on top, reaching out of a box that holds the rest — the "⋯" (order,
	   remove) inside at the top end, and the settings. */
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		padding-bottom: 10px;
		/* The diagram's lines take the line colour; what is written in a step does not. */
		color: var(--text-primary);
	}

	/* The picker's preview: what a step can be set to. */
	.step-settings {
		display: grid;
		gap: 4px;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}

	.step-settings p {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	.step-settings ul {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.step-settings li {
		padding: 1px 8px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge);
		background: var(--bg-card);
	}

	/* The step's name: pressing it opens the picker to change it. */
	.step-choice {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		height: var(--control-h-sm);
		padding-inline: 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-label);
		text-align: start;
		cursor: pointer;
	}

	.step-choice:hover:not(:disabled) {
		border-color: var(--text-muted);
	}

	.step-choice:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	.step-choice:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.step-choice__label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.step-choice__caret {
		display: inline-flex;
		color: var(--text-muted);
		--icon-size: var(--icon-sm);
	}

	.card__name {
		position: relative;
		z-index: 1;
		/* Leaves room for the "⋯" at the box's end. */
		width: calc(100% - 34px);
		min-width: 0;
	}

	.card__box {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
		/* Starts just under the name's top edge; the name overlaps its start. */
		margin-top: calc(var(--control-h-sm) * -1 + 4px);
		margin-inline-start: 10px;
		padding: calc(var(--control-h-sm) + 2px) 8px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	.card__menu {
		position: absolute;
		top: 4px;
		inset-inline-end: 4px;
	}

	.slot__add {
		display: flex;
		align-items: center;
		height: var(--control-h-sm);
		min-width: 0;
	}

	.slot__add .flow__add {
		margin-inline: 0;
	}

	.slot__add .flow__line {
		border-top-style: dashed;
		opacity: 0.7;
	}

	/* While open, the target's name in words sits under it. */
	.mrow__tlabel {
		flex-basis: 100%;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.ed__param-hint {
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-regular);
	}

	.ed__hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
		line-height: var(--lh-snug);
	}

	/* A problem stays within the transform column, its fixes under it. */
	.mrow__problem {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.mrow__fixes {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.mrow__problem p {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		color: var(--warning-text);
		font-size: var(--fs-caption);
		--icon-size: var(--icon-sm);
	}

	.mapping__note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	/* Narrow screens: the same shares, the toggle column shrinks. */
	@media (max-width: 720px) {
		.mapping {
			--map-cols: minmax(0, 1fr) minmax(7rem, 1.3fr) minmax(0, 1fr) 2rem;
			--map-gap: 8px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mrow__chev {
			transition: none;
		}
	}
</style>
