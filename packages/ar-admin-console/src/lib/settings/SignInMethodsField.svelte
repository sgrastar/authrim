<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';

	/**
	 * Which ways an administrator can sign in to the console (`security.admin_sign_in_methods`):
	 * a list of methods. The passkey is always there, so the platform can never turn the last way
	 * in off; signing in with a wallet (a presentation of the admin credential) is opt-in while it
	 * is being built out. Off, the sign-in page shows no wallet button and the API refuses it.
	 */
	interface Props {
		value: unknown;
		onvalue: (value: string[]) => void;
		changed?: boolean;
		disabled?: boolean;
	}

	let { value, onvalue, changed, disabled = false }: Props = $props();

	const methods = $derived(
		Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string') : []
	);
	const vcOn = $derived(methods.includes('vc'));

	function setVc(on: boolean) {
		onvalue(on ? ['passkey', 'vc'] : ['passkey']);
	}
</script>

<div class="methods">
	<Checkbox checked disabled description={t('set.method.passkey.desc')}>
		{t('set.method.passkey')}
	</Checkbox>
	<Checkbox
		checked={vcOn}
		{disabled}
		{changed}
		description={t('set.method.vc.desc')}
		onchange={(event) => setVc(event.currentTarget.checked)}
	>
		{t('set.method.vc')}
	</Checkbox>
</div>

<style>
	.methods {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}
</style>
