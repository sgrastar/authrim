<script lang="ts">
	interface Props {
		label: string;
	}

	let { label }: Props = $props();
</script>

<div class="nav-group-label">{label}</div>

<style>
	.nav-group-label {
		padding: var(--nav-group-label-padding, 8px 20px 4px);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--nav-group-label-font-size, 0.65rem);
		font-weight: var(--nav-group-label-font-weight, 700);
		text-transform: uppercase;
		letter-spacing: var(--nav-group-label-letter-spacing, 0.1em);
		color: var(--nav-group-label-color, var(--color-text-subtle));
		white-space: nowrap;
		overflow: hidden;
		margin-top: var(--nav-group-label-margin-top, 8px);
	}

	.nav-group-label::after {
		content: '';
		display: var(--nav-group-rule-display, none);
		height: 1px;
		margin-top: var(--nav-group-rule-margin-top, 5px);
		background: var(--nav-group-rule-bg, var(--color-border));
	}

	.nav-group-label:first-of-type {
		margin-top: 0;
	}
</style>
