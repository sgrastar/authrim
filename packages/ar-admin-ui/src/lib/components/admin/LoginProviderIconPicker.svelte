<script lang="ts">
	interface IconOption {
		value: string;
		label: string;
	}

	interface Props {
		value?: string;
		defaultIcon?: string;
		defaultLabel?: string;
		label?: string;
		description?: string;
	}

	let {
		value = $bindable(''),
		defaultIcon = 'buildings',
		defaultLabel = 'Default',
		label = 'Login Button Icon',
		description = 'Shown on Login UI buttons when no logo image URL is configured.'
	}: Props = $props();

	let open = $state(false);

	const iconOptions: IconOption[] = [
		{ value: 'buildings', label: 'Buildings' },
		{ value: 'house', label: 'House' },
		{ value: 'house-simple', label: 'Simple House' },
		{ value: 'bank', label: 'Bank' },
		{ value: 'building', label: 'Building' },
		{ value: 'city', label: 'City' },
		{ value: 'graduation-cap', label: 'Graduation' },
		{ value: 'student', label: 'Student' },
		{ value: 'books', label: 'Books' },
		{ value: 'chalkboard-teacher', label: 'Classroom' },
		{ value: 'globe', label: 'Globe' },
		{ value: 'globe-hemisphere-east', label: 'Federation' },
		{ value: 'shield-check', label: 'Shield' },
		{ value: 'seal-check', label: 'Verified' },
		{ value: 'certificate', label: 'Certificate' },
		{ value: 'identification-card', label: 'ID Card' },
		{ value: 'fingerprint', label: 'Fingerprint' },
		{ value: 'key', label: 'Key' },
		{ value: 'briefcase', label: 'Briefcase' },
		{ value: 'users-three', label: 'Users' },
		{ value: 'network', label: 'Network' },
		{ value: 'share-network', label: 'SSO' },
		{ value: 'tree-structure', label: 'Tree Structure' },
		{ value: 'handshake', label: 'Handshake' },
		{ value: 'cloud', label: 'Cloud' },
		{ value: 'cloud-check', label: 'Cloud Check' },
		{ value: 'database', label: 'Database' },
		{ value: 'hard-drives', label: 'Server' },
		{ value: 'devices', label: 'Devices' },
		{ value: 'terminal-window', label: 'Terminal' },
		{ value: 'book-open', label: 'Book Open' },
		{ value: 'presentation-chart', label: 'Presentation' },
		{ value: 'rocket-launch', label: 'Rocket' },
		{ value: 'compass', label: 'Compass' }
	];

	function iconClass(icon: string) {
		return `i-ph-${icon}`;
	}

	function selectedLabel() {
		if (value === 'none') return 'No icon';
		if (!value) return defaultLabel;
		return iconOptions.find((option) => option.value === value)?.label ?? value;
	}

	function selectedIcon() {
		if (value === 'none') return '';
		return value || defaultIcon;
	}

	function choose(nextValue: string) {
		value = nextValue;
		open = false;
	}
</script>

<div class="icon-picker" class:icon-picker--open={open}>
	<div class="icon-picker__header">
		<div>
			<span class="form-label">{label}</span>
			<p class="form-hint">{description}</p>
		</div>
		<button type="button" class="icon-picker__trigger" onclick={() => (open = !open)}>
			<span class="icon-picker__preview" aria-hidden="true">
				{#if selectedIcon()}
					<i class={iconClass(selectedIcon())}></i>
				{:else}
					<span class="icon-picker__none"></span>
				{/if}
			</span>
			<span>{selectedLabel()}</span>
			<i class="i-ph-caret-down icon-picker__chevron"></i>
		</button>
	</div>

	{#if open}
		<div class="icon-picker__panel">
			<button
				type="button"
				class="icon-picker__option"
				class:icon-picker__option--selected={value === 'none'}
				onclick={() => choose('none')}
				aria-label="No icon"
				title="No icon"
			>
				<span class="icon-picker__option-icon icon-picker__option-icon--none" aria-hidden="true"
				></span>
			</button>

			<button
				type="button"
				class="icon-picker__option"
				class:icon-picker__option--selected={value === ''}
				onclick={() => choose('')}
				aria-label={defaultLabel}
				title={defaultLabel}
			>
				<span class="icon-picker__option-icon" aria-hidden="true">
					<i class={iconClass(defaultIcon)}></i>
				</span>
			</button>

			{#each iconOptions as option (option.value)}
				<button
					type="button"
					class="icon-picker__option"
					class:icon-picker__option--selected={value === option.value}
					onclick={() => choose(option.value)}
					aria-label={option.label}
					title={option.label}
				>
					<span class="icon-picker__option-icon" aria-hidden="true">
						<i class={iconClass(option.value)}></i>
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.icon-picker {
		display: grid;
		gap: 12px;
		position: relative;
	}

	:global(.panel:has(.icon-picker--open)) {
		position: relative;
		z-index: 1000;
		overflow: visible;
	}

	.icon-picker__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.icon-picker__trigger {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 180px;
		height: 40px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-weight: 600;
		cursor: pointer;
	}

	.icon-picker__preview,
	.icon-picker__option-icon {
		display: inline-grid;
		width: 24px;
		height: 24px;
		flex: 0 0 24px;
		place-items: center;
		color: var(--text-secondary);
	}

	.icon-picker__preview i,
	.icon-picker__option-icon i {
		width: 20px;
		height: 20px;
	}

	.icon-picker__none,
	.icon-picker__option-icon--none {
		border: 1px dashed var(--border);
		border-radius: 6px;
	}

	.icon-picker__chevron {
		margin-left: auto;
		width: 16px;
		height: 16px;
		color: var(--text-muted);
	}

	.icon-picker__panel {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 1001;
		display: grid;
		grid-template-columns: repeat(9, 48px);
		justify-self: end;
		width: max-content;
		max-width: 100%;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-card) 96%, black 4%);
		box-shadow: 0 18px 48px rgb(0 0 0 / 0.34);
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
	}

	.icon-picker__option {
		display: inline-grid;
		align-items: center;
		justify-content: center;
		width: 100%;
		aspect-ratio: 1;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-input);
		color: var(--text-primary);
		cursor: pointer;
	}

	.icon-picker__option-icon {
		width: 28px;
		height: 28px;
	}

	.icon-picker__option-icon i {
		width: 22px;
		height: 22px;
	}

	.icon-picker__option:hover,
	.icon-picker__option--selected {
		border-color: var(--primary);
		color: var(--primary);
		background: var(--primary-light);
	}

	@media (max-width: 640px) {
		.icon-picker__header {
			display: grid;
		}

		.icon-picker__trigger {
			width: 100%;
		}

		.icon-picker__panel {
			position: static;
			grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
			justify-self: stretch;
			width: 100%;
		}
	}
</style>
