<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { Schema } from '#lib/api/schema-setting.js';
	import type { ScreenListItem } from '#lib/api/screens.js';
	import type { ClientOption } from '#lib/api/clients.js';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import ConditionBuilder from '#lib/ui/patterns/ConditionBuilder.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { conditionAnswersOf, conditionAttributesOf, localeChoices } from './condition-choices';
	import { useFlowResources } from './flow-resources-context';
	import {
		conditionFieldsOf,
		groupOf,
		MAX_CONDITION_RULES,
		valueOfGroup,
		withRuleFields,
		type ConditionSource
	} from './step-condition-model';

	/**
	 * Who a flow step is shown to: rules that must all hold (an attribute of the person, their age,
	 * an answer given on one of the flow's screens, the app, the language). No rule: everyone. The
	 * rules are drawn by the console's ConditionBuilder, with "all" said, not chosen: "any of" is
	 * another step with its own rules.
	 */
	interface Props {
		label: string;
		hint?: string;
		/** The rules, as `step-condition-model.ts` keeps them. */
		value: string[];
		onchange: (value: string[]) => void;
		/** The keys of the flow's screens whose answers a rule can compare. */
		answerScreens?: readonly string[];
	}

	let { label, hint, value, onchange, answerScreens = [] }: Props = $props();

	const resources = useFlowResources();
	let schemas = $state<Schema[]>([]);
	let screens = $state<ScreenListItem[]>([]);
	let clients = $state<ClientOption[]>([]);
	let failed = $state(false);
	/**
	 * Every list was read. Until then the rules are not edited: a rule is checked and drawn by what
	 * it compares (an attribute's type, a screen part's kind, the apps), which a saved rule does not
	 * carry; a rule drawn without it could be changed into another one.
	 */
	let ready = $state(false);
	let controller: AbortController | undefined;
	onDestroy(() => controller?.abort());

	async function load() {
		controller?.abort();
		const current = new AbortController();
		controller = current;
		failed = false;
		ready = false;
		const [schemaRead, screenRead, clientRead] = await Promise.allSettled([
			resources.userAttributes ? resources.userAttributes(current.signal) : Promise.resolve([]),
			resources.screens.list(),
			resources.clients.list(current.signal)
		]);
		if (current.signal.aborted) return;
		if (
			schemaRead.status === 'rejected' ||
			screenRead.status === 'rejected' ||
			clientRead.status === 'rejected'
		) {
			failed = true;
			return;
		}
		schemas = schemaRead.value;
		screens = screenRead.value.screens;
		clients = clientRead.value;
		ready = true;
	}
	onMount(() => void load());

	function sourceLabel(source: ConditionSource, name?: string): string {
		const base = t(`af.when.source.${source}` as MessageKey);
		return name ? `${base}: ${name}` : base;
	}

	const group = $derived(groupOf(value));
	const fields = $derived(
		withRuleFields(
			conditionFieldsOf({
				attributes: conditionAttributesOf(schemas, i18n.locale, (key) =>
					t(`af.when.attr.${key}` as MessageKey)
				),
				answers: conditionAnswersOf(screens, answerScreens),
				apps: clients.map((client) => ({ value: client.id, label: client.name })),
				locales: localeChoices(),
				label: sourceLabel
			}),
			group.children.flatMap((child) => (child.kind === 'rule' ? [child] : [])),
			sourceLabel
		)
	);
</script>

<div class="when">
	{#if !ready}
		{#if !failed}<LoadingState label={t('common.loading')} />{/if}
	{:else}
		<ConditionBuilder
			{label}
			bind:value={() => group, (next) => onchange(valueOfGroup(next, fields))}
			{fields}
			maxDepth={1}
			matches={['all']}
			maxRules={MAX_CONDITION_RULES}
			emptyText={t('af.when.everyone')}
		/>
	{/if}
	{#if hint}<p class="when__hint">{hint}</p>{/if}
	{#if failed}
		<Callout tone="warning">
			{t('af.when.loadFailed')}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{/if}
</div>

<style>
	.when {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.when__hint {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
