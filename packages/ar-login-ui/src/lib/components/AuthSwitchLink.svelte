<script lang="ts">
	interface Props {
		href: string;
		label: string;
		loadingLabel: string;
	}

	let { href, label, loadingLabel }: Props = $props();
	let loading = $state(false);

	function handleClick(event: MouseEvent): void {
		if (
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		) {
			return;
		}

		if (loading) {
			event.preventDefault();
			return;
		}
		loading = true;
	}
</script>

<a
	{href}
	class="auth-switch-link"
	class:auth-switch-link--loading={loading}
	data-sveltekit-reload
	aria-busy={loading}
	aria-disabled={loading}
	onclick={handleClick}
>
	<span
		class="auth-switch-link__spinner"
		class:auth-switch-link__spinner--visible={loading}
		aria-hidden="true"
	></span>
	<span>{label}</span>
	<span class="sr-only" aria-live="polite">{loading ? loadingLabel : ''}</span>
</a>

<style>
	.auth-switch-link {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.auth-switch-link--loading {
		cursor: wait;
	}

	.auth-switch-link__spinner {
		position: absolute;
		right: calc(100% + 7px);
		width: 12px;
		height: 12px;
		box-sizing: border-box;
		border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
		border-top-color: currentColor;
		border-radius: 50%;
		opacity: 0;
		pointer-events: none;
	}

	.auth-switch-link__spinner--visible {
		opacity: 1;
		animation: auth-switch-spin 0.75s linear infinite;
	}

	@keyframes auth-switch-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.auth-switch-link__spinner--visible {
			animation: none;
		}
	}
</style>
