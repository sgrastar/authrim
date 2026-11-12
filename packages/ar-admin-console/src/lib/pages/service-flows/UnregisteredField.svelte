<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import type { AccountChoice } from './flow-spec';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * What a sign-in tells someone whose address has no account. Telling them (`guide`) lets anyone
	 * find out which addresses have one, so it is offered only where the tenant has a sign-up to
	 * point them to; the same answer for everyone (`generic`) is the default.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		value: string;
		options: AccountChoice[];
		onchange: (value: string) => void;
	}
	let { label, hint, required = false, value, options, onchange }: Props = $props();

	const { flows } = useFlowResources();
	/** Whether the tenant has a sign-up Flow (null while it is read; the mock pages have one). */
	let signUp = $state<boolean | null>(flows ? null : true);
	const controller = new AbortController();
	onMount(async () => {
		if (!flows) return;
		try {
			signUp = (await flows.tenantFlow('registration', controller.signal)) !== null;
		} catch {
			// Not known: keep `guide` open only if it is already chosen (nothing is taken away).
			signUp = false;
		}
	});
	onDestroy(() => controller.abort());

	const shown = $derived(
		options.map((option) =>
			option.value === 'guide'
				? { ...option, disabled: signUp !== true && value !== 'guide' }
				: option
		)
	);
</script>

<SelectRow
	{label}
	{required}
	hint={signUp === false ? t('af.hint.login.unregisteredNoSignUp') : hint}
	{value}
	onchange={(chosen) => onchange(chosen)}
	options={shown}
/>
