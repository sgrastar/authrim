<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';

	/**
	 * Which kinds of second factor satisfy L2 (`security.admin_second_factor_allowed_kinds`): a
	 * list of strengths. A security key or Keyring (`hardware`) is always allowed, so the tenant
	 * can never lock every admin out; an authenticator app (`totp`) is weaker and is opt-in.
	 */
	interface Props {
		value: unknown;
		onvalue: (value: string[]) => void;
		changed?: boolean;
		disabled?: boolean;
	}

	let { value, onvalue, changed, disabled = false }: Props = $props();

	const kinds = $derived(
		Array.isArray(value) ? value.filter((kind): kind is string => typeof kind === 'string') : []
	);
	const totpOn = $derived(kinds.includes('totp'));

	function setTotp(on: boolean) {
		onvalue(on ? ['hardware', 'totp'] : ['hardware']);
	}
</script>

<div class="kinds">
	<Checkbox checked disabled description={t('set.kind.hardware.desc')}>
		{t('set.kind.hardware')}
	</Checkbox>
	<Checkbox
		checked={totpOn}
		{disabled}
		{changed}
		description={t('set.kind.totp.desc')}
		onchange={(event) => setTotp(event.currentTarget.checked)}
	>
		{t('set.kind.totp')}
	</Checkbox>
</div>

<style>
	.kinds {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}
</style>
