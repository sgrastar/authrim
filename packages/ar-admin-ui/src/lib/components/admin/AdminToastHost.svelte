<script lang="ts">
	import { onMount } from 'svelte';
	import { flip } from 'svelte/animate';
	import { fly } from 'svelte/transition';
	import { melt } from '@melt-ui/svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { findToastSources, readToastSource, TOAST_SOURCE_SELECTOR } from '$lib/toast-dom';
	import { toast, toastElements, toastPortal, toastState, type ToastTone } from '$lib/toast';
	const { content, title, description, close } = toastElements;
	const lastMessageByElement = new WeakMap<Element, string>();

	function titleFor(tone: ToastTone): string {
		switch (tone) {
			case 'success':
				return $LL.common_status_success();
			case 'error':
				return $LL.common_status_error();
			case 'warning':
				return $LL.common_status_warning();
			case 'info':
				return $LL.common_status_info();
		}
	}

	function trackProgress(node: HTMLElement, getPercentage: () => number) {
		let frame = 0;
		const update = () => {
			const percentage = Math.max(0, Math.min(100, getPercentage()));
			node.style.setProperty('--toast-progress', `${percentage}%`);
			frame = requestAnimationFrame(update);
		};
		frame = requestAnimationFrame(update);

		return {
			destroy: () => cancelAnimationFrame(frame)
		};
	}

	function publishSource(source: ReturnType<typeof readToastSource>): void {
		if (!source) return;
		const fingerprint = `${source.tone}:${source.message}`;
		if (lastMessageByElement.get(source.element) === fingerprint) return;

		lastMessageByElement.set(source.element, fingerprint);
		toast[source.tone](source.message, { dedupeWindow: 1500 });
	}

	function processNode(node: Node): void {
		if (node instanceof Element) {
			const directSource = readToastSource(node);
			if (node.matches(TOAST_SOURCE_SELECTOR) && !directSource) {
				lastMessageByElement.delete(node);
			}
			for (const source of findToastSources(node)) publishSource(source);
			return;
		}

		if (node instanceof CharacterData && node.parentElement) {
			const source = readToastSource(node.parentElement);
			if (!source && node.parentElement.matches(TOAST_SOURCE_SELECTOR)) {
				lastMessageByElement.delete(node.parentElement);
			}
			publishSource(source);
		}
	}

	onMount(() => {
		for (const source of findToastSources(document.body)) publishSource(source);

		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === 'characterData' || mutation.type === 'attributes') {
					processNode(mutation.target);
					continue;
				}
				for (const node of mutation.addedNodes) processNode(node);
				processNode(mutation.target);
			}
		});

		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ['class', 'data-admin-toast', 'data-admin-toast-message'],
			childList: true,
			characterData: true,
			subtree: true
		});

		return () => observer.disconnect();
	});
</script>

<div class="toast-viewport" data-admin-toast-viewport use:toastPortal>
	{#each $toastState as item (item.id)}
		<div
			use:melt={$content(item.id)}
			animate:flip={{ duration: 500 }}
			in:fly={{ duration: 150, x: '100%' }}
			out:fly={{ duration: 150, x: '100%' }}
			class="toast toast--{item.data.tone}"
		>
			<div class="toast__progress" use:trackProgress={item.getPercentage} aria-hidden="true">
				<span class="toast__progress-value"></span>
			</div>
			<div class="toast__body">
				<p use:melt={$title(item.id)} class="toast__title">
					{item.data.title ?? titleFor(item.data.tone)}
					<span class="toast__tone" aria-hidden="true"></span>
				</p>
				<p use:melt={$description(item.id)} class="toast__message">{item.data.message}</p>
			</div>
			<button
				use:melt={$close(item.id)}
				class="toast__close"
				aria-label={$LL.common_dismiss_alert()}
			>
				<span class="i-ph-x" aria-hidden="true"></span>
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-viewport {
		position: fixed;
		right: 0;
		bottom: 0;
		z-index: calc(var(--z-toast, 1000) + 1);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		margin: 16px;
		pointer-events: none;
	}

	.toast {
		--toast-tone: #3b82f6;
		position: relative;
		width: 24rem;
		max-width: calc(100vw - 2rem);
		padding: 24px 20px 20px;
		overflow: hidden;
		color: #fff;
		background: #262626;
		border-radius: 8px;
		box-shadow:
			0 4px 6px -1px rgb(0 0 0 / 0.2),
			0 2px 4px -2px rgb(0 0 0 / 0.2);
		pointer-events: auto;
	}

	.toast--success {
		--toast-tone: #22c55e;
	}

	.toast--error {
		--toast-tone: #ef4444;
	}

	.toast--warning {
		--toast-tone: #f97316;
	}

	.toast--info {
		--toast-tone: #3b82f6;
	}

	.toast__body {
		min-width: 0;
		padding-right: 24px;
	}

	.toast__progress {
		position: absolute;
		top: 8px;
		left: 20px;
		width: 10%;
		height: 4px;
		overflow: hidden;
		background: rgb(0 0 0 / 0.4);
		border-radius: 999px;
	}

	.toast__progress-value {
		display: block;
		width: 100%;
		height: 100%;
		background: #a3a3a3;
		border-radius: inherit;
		transform: translateX(calc(-100% + var(--toast-progress, 0%)));
		will-change: transform;
	}

	.toast__title,
	.toast__message {
		margin: 0;
	}

	.toast__title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.4;
		color: #fff;
	}

	.toast__tone {
		width: 6px;
		height: 6px;
		flex: 0 0 auto;
		background: var(--toast-tone);
		border-radius: 999px;
	}

	.toast__message {
		margin-top: 2px;
		max-height: 9rem;
		font-size: 1rem;
		line-height: 1.5;
		overflow-y: auto;
		overflow-wrap: anywhere;
		color: #e5e5e5;
	}

	.toast__close {
		position: absolute;
		top: 16px;
		right: 16px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		font-size: 16px;
		color: #a3a3a3;
		background: transparent;
		border: 0;
		border-radius: 999px;
		cursor: pointer;
	}

	.toast__close:hover {
		color: #fff;
		background: rgb(0 0 0 / 0.35);
	}

	.toast__close:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 1px;
	}

	@media (max-width: 768px) {
		.toast-viewport {
			margin: 12px;
		}

		.toast {
			max-width: calc(100vw - 24px);
		}
	}
</style>
