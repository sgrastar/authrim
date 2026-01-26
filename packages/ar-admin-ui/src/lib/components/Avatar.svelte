<script lang="ts">
	import { getAvatarUrl, getInitials } from '$lib/utils/gravatar';

	/** User's email address (used for Gravatar) */
	export let email: string | null | undefined = undefined;

	/** User's display name (used for initials fallback) */
	export let name: string | null | undefined = undefined;

	/** Custom avatar URL (takes priority over Gravatar) */
	export let picture: string | null | undefined = undefined;

	/** Avatar size */
	export let size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' = 'md';

	/** Show border ring */
	export let ring: boolean = false;

	/** Additional CSS classes */
	let className = '';
	export { className as class };

	// Size mapping for Gravatar
	const sizeMap = {
		xs: 24,
		sm: 32,
		md: 40,
		lg: 48,
		xl: 64
	};

	// Track image load state
	let imageError = false;
	let imageLoaded = false;

	// Compute avatar URL
	$: avatarUrl = getAvatarUrl(email, picture, {
		size: sizeMap[size] * 2, // 2x for retina
		default: 'identicon'
	});

	// Compute initials
	$: initials = getInitials(email, name);

	// Handle image error - show initials fallback
	function handleError() {
		imageError = true;
	}

	function handleLoad() {
		imageLoaded = true;
	}

	// Reset state when props change
	$: if (email || picture) {
		imageError = false;
		imageLoaded = false;
	}
</script>

<div class="avatar avatar-{size} {className}" class:ring class:loaded={imageLoaded}>
	{#if !imageError}
		<img
			src={avatarUrl}
			alt={name || email || 'Avatar'}
			on:error={handleError}
			on:load={handleLoad}
			class:visible={imageLoaded}
		/>
	{/if}
	<span class="initials" class:visible={imageError || !imageLoaded}>
		{initials}
	</span>
</div>

<style>
	.avatar {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--gradient-accent, linear-gradient(135deg, #6366f1, #8b5cf6));
		overflow: hidden;
		flex-shrink: 0;
		transition: box-shadow 0.2s ease;
	}

	.avatar.ring {
		box-shadow: 0 0 0 2px var(--color-bg-primary, #fff),
			0 0 0 4px var(--color-accent, #6366f1);
	}

	/* Sizes */
	.avatar-xs {
		width: 24px;
		height: 24px;
		font-size: 10px;
	}

	.avatar-sm {
		width: 32px;
		height: 32px;
		font-size: 12px;
	}

	.avatar-md {
		width: 40px;
		height: 40px;
		font-size: 14px;
	}

	.avatar-lg {
		width: 48px;
		height: 48px;
		font-size: 16px;
	}

	.avatar-xl {
		width: 64px;
		height: 64px;
		font-size: 20px;
	}

	/* Image */
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	img.visible {
		opacity: 1;
	}

	/* Initials fallback */
	.initials {
		color: white;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		user-select: none;
		opacity: 1;
		transition: opacity 0.2s ease;
	}

	.initials:not(.visible) {
		opacity: 0;
	}

	/* Hover effect */
	.avatar:hover {
		transform: scale(1.02);
	}
</style>
