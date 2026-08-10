<script lang="ts">
	let {
		width = '100%',
		height = '1rem',
		radius = '0.5rem',
		class: className = ''
	} = $props<{
		width?: string;
		height?: string;
		radius?: string;
		class?: string;
	}>();
</script>

<span
	class="skeleton {className}"
	style:--skeleton-width={width}
	style:--skeleton-height={height}
	style:--skeleton-radius={radius}
	aria-hidden="true"
></span>

<style>
	.skeleton {
		display: block;
		width: var(--skeleton-width);
		height: var(--skeleton-height);
		overflow: hidden;
		position: relative;
		border-radius: var(--skeleton-radius);
		background: color-mix(in srgb, var(--text-primary) 9%, var(--bg-card));
	}

	.skeleton::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			color-mix(in srgb, var(--text-primary) 9%, transparent) 50%,
			transparent 100%
		);
		transform: translateX(-100%);
	}

	@media (prefers-reduced-motion: no-preference) {
		.skeleton::after {
			animation: skeleton-shimmer 1.6s ease-in-out infinite;
		}
	}

	@keyframes skeleton-shimmer {
		to {
			transform: translateX(100%);
		}
	}
</style>
