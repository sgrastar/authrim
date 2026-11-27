<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import { RBAC_CLAIMS, claimsOf, toggleClaim } from './claim-list';

	/**
	 * Which RBAC claims a token carries (`tokens.rbac_id_token_claims`,
	 * `tokens.rbac_access_token_claims`): a comma-separated list in the API, a box per claim
	 * here. None ticked stores `none` (an empty value would mean the built-in default).
	 */
	interface Props {
		key: string;
		value: unknown;
		onvalue: (value: string) => void;
		changed?: boolean;
		disabled?: boolean;
	}

	let { key, value, onvalue, changed, disabled = false }: Props = $props();

	const DESCRIPTION: Readonly<Record<string, MessageKey>> = {
		roles: 'set.claim.roles.desc',
		groups: 'set.claim.groups.desc',
		permissions: 'set.claim.permissions.desc',
		scoped_roles: 'set.claim.scoped_roles.desc',
		user_type: 'set.claim.user_type.desc',
		relationships_summary: 'set.claim.relationships_summary.desc'
	};

	const offered = $derived(RBAC_CLAIMS[key] ?? []);
	const claims = $derived(claimsOf(value));
	// A claim stored that this console does not know stays, so saving never drops it.
	const unknown = $derived(claims.filter((claim) => !offered.includes(claim)));

	function set(claim: string, on: boolean) {
		onvalue(toggleClaim(value, claim, on, offered));
	}
</script>

<div class="claims">
	{#each offered as claim (claim)}
		<Checkbox
			checked={claims.includes(claim)}
			{disabled}
			{changed}
			description={DESCRIPTION[claim] ? t(DESCRIPTION[claim]) : undefined}
			onchange={(event) => set(claim, event.currentTarget.checked)}
		>
			<code>{claim}</code>
		</Checkbox>
	{/each}
	{#each unknown as claim (claim)}
		<Checkbox checked disabled>
			<code>{claim}</code>
		</Checkbox>
	{/each}
</div>

<style>
	.claims {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}
</style>
