<script lang="ts" module>
	/** What a form with its own Save button needs from its SaveScope (`bar={false}`). */
	export interface SaveControls {
		save: () => Promise<void>;
		discard: () => void;
		readonly dirty: boolean;
		readonly saving: boolean;
		/** Some field holds a value that cannot be saved; `save()` shows it instead. */
		readonly invalid: boolean;
	}
</script>

<script lang="ts" generics="T extends object">
	import { tick, type Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { beforeNavigate, goto } from '$app/navigation';
	import { t } from '$lib/i18n/i18n.svelte';
	import { provideBusy } from '../busy/busy';
	import SaveBar from '../patterns/SaveBar.svelte';
	import { toast } from '../toast/toast.svelte';
	import { copyValue, type Draft } from './draft.svelte';
	import LeaveConfirm from './LeaveConfirm.svelte';
	import { leaveDecision } from './leave-guard';
	import { provideSaveScope, SaveStopped } from './save-scope';

	/**
	 * Every settings page that is confirmed with Save wraps its form in a SaveScope:
	 * - controls given a `field` (a dotted path into `draft.value`) mark themselves once their
	 *   value differs from the saved one;
	 * - the save bar rises from the bottom while anything is unsaved and sinks back after Save
	 *   or Discard;
	 * - while saving, everything inside is busy;
	 * - leaving with unsaved changes asks first: a console dialog for moves inside the console,
	 *   the browser's own dialog for closing the tab, reloading or going to another site.
	 * Immediate-effect switches (Toggle) do not belong in a SaveScope.
	 *
	 * A form with its own Save button (a dialog, a short inline form) sets `bar={false}` and
	 * uses the controls passed to its content; the marks and the leave check still apply.
	 */
	interface Props {
		draft: Draft<T>;
		/** Persist the values; throw to keep them unsaved (the error is shown as a toast). */
		onsave: (value: T) => Promise<void> | void;
		/** Show the save bar. Off for forms with their own Save button. */
		bar?: boolean;
		children: Snippet<[SaveControls]>;
	}

	let { draft, onsave, bar = true, children }: Props = $props();

	let saving = $state(false);
	/** Fields that currently hold something that cannot be saved. */
	const invalidFields = new SvelteSet<symbol>();
	const invalid = $derived(invalidFields.size > 0);

	provideSaveScope({
		original: (field) => draft.original(field),
		report: (field, bad) => {
			if (bad) invalidFields.add(field);
			else invalidFields.delete(field);
		}
	});
	provideBusy(() => saving);

	/** Where the admin wanted to go when the leave dialog opened. */
	let leaveTo = $state<URL | null>(null);

	beforeNavigate((navigation) => {
		const decision = leaveDecision(navigation, draft.dirty);
		if (decision === 'allow') return;
		// Cancelling an unload makes the browser show its own "leave site?" dialog.
		navigation.cancel();
		if (decision === 'ask' && navigation.to) leaveTo = navigation.to.url;
	});

	function leave() {
		const target = leaveTo;
		leaveTo = null;
		draft.discard();
		if (target) goto(target);
	}

	const controls: SaveControls = {
		save: () => save(),
		discard: () => draft.discard(),
		get dirty() {
			return draft.dirty;
		},
		get saving() {
			return saving;
		},
		get invalid() {
			return invalid;
		}
	};

	async function save() {
		// Never send what a field has flagged: take the admin to the first problem instead.
		if (invalid) {
			await tick();
			document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		saving = true;
		try {
			await onsave(copyValue(draft.value));
			draft.commit();
		} catch (error) {
			if (error instanceof SaveStopped) return;
			toast.error(error instanceof Error && error.message ? error.message : t('common.saveFailed'));
		} finally {
			saving = false;
		}
	}
</script>

{@render children(controls)}
{#if bar}
	<SaveBar dirty={draft.dirty} {saving} {invalid} onsave={save} ondiscard={() => draft.discard()} />
{/if}
<LeaveConfirm open={leaveTo !== null} onleave={leave} onstay={() => (leaveTo = null)} />
