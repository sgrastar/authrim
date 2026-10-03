<script module lang="ts">
	import type { AccountPageScreenField } from '$lib/api/account';

	/** The block types a published account page draws itself, without an account widget. */
	export type AccountScreenStaticBlockType = 'heading' | 'text' | 'link' | 'divider';

	export function isAccountScreenStaticBlock(
		blockType: AccountPageScreenField['block_type']
	): blockType is AccountScreenStaticBlockType {
		return (
			blockType === 'heading' ||
			blockType === 'text' ||
			blockType === 'link' ||
			blockType === 'divider'
		);
	}
</script>

<script lang="ts">
	/**
	 * A heading, text, link or divider block of a published account page composition. Other block
	 * types (the account widgets) draw nothing here.
	 */
	let {
		field,
		href = null
	}: {
		field: Pick<AccountPageScreenField, 'block_type' | 'label' | 'text'>;
		/**
		 * A link block's target, already checked by `safeAccountScreenHref`; without one the link is
		 * left out.
		 */
		href?: string | null;
	} = $props();
</script>

{#if field.block_type === 'heading'}
	<header class="account-screen__heading">
		<h2>{field.label}</h2>
		{#if field.text}<p>{field.text}</p>{/if}
	</header>
{:else if field.block_type === 'text'}
	<p class="account-screen__text">{field.text || field.label}</p>
{:else if field.block_type === 'link' && href}
	<a class="account-screen__link" {href}>{field.label}</a>
{:else if field.block_type === 'divider'}
	<div class="account-screen__divider"><span>{field.text ?? ''}</span></div>
{/if}

<style>
	.account-screen__heading h2,
	.account-screen__heading p,
	.account-screen__text {
		margin: 0;
	}

	.account-screen__heading h2 {
		font-size: 1.05rem;
	}

	.account-screen__heading p,
	.account-screen__text {
		margin-top: 4px;
		color: var(--text-muted);
		font-size: 0.875rem;
		line-height: 1.65;
	}

	.account-screen__divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.account-screen__divider::before,
	.account-screen__divider::after {
		content: '';
		flex: 1;
		border-top: 1px solid var(--border);
	}
</style>
