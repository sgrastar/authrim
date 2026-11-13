<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import type { SignaturePolicy } from './connection-settings';

	/** Whether a signed message from the other side is required, checked if signed, or not checked. */
	interface Props {
		label: string;
		value: SignaturePolicy;
		onchange: (value: SignaturePolicy) => void;
	}

	let { label, value, onchange }: Props = $props();
</script>

<SelectRow
	{label}
	{value}
	onchange={(next) => onchange(next as SignaturePolicy)}
	options={[
		{ value: 'required', label: t('cs.sig.required') },
		{ value: 'optional', label: t('cs.sig.optional') },
		{ value: 'disabled', label: t('cs.sig.disabled') }
	]}
/>
