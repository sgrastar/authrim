<script lang="ts">
	interface Props {
		label: string;
		info: string;
		previousLabel: string;
		nextLabel: string;
		hasPrevious: boolean;
		hasNext: boolean;
		onPrevious: () => void;
		onNext: () => void;
	}

	let { label, info, previousLabel, nextLabel, hasPrevious, hasNext, onPrevious, onNext }: Props =
		$props();
</script>

<nav class="admin-pagination" aria-label={label}>
	<p class="admin-pagination__info">{info}</p>
	<div class="admin-pagination__actions">
		<button class="btn btn-secondary btn-sm" onclick={onPrevious} disabled={!hasPrevious}>
			{previousLabel}
		</button>
		<button class="btn btn-secondary btn-sm" onclick={onNext} disabled={!hasNext}>
			{nextLabel}
		</button>
	</div>
</nav>

<style>
	.admin-pagination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-top: 16px;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.admin-pagination__info {
		margin: 0;
	}

	.admin-pagination__actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	@media (max-width: 720px) {
		.admin-pagination {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
