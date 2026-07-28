import { createToaster } from '@melt-ui/svelte';
import { get } from 'svelte/store';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface AdminToastData {
	tone: ToastTone;
	message: string;
	title?: string;
}

export interface ToastOptions {
	title?: string;
	duration?: number;
	dedupeKey?: string;
	dedupeWindow?: number;
}

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_DURATION: Record<ToastTone, number> = {
	success: 5000,
	error: 8000,
	warning: 7000,
	info: 5000
};

const toaster = createToaster<AdminToastData>({
	closeDelay: DEFAULT_DURATION.info,
	type: 'background',
	hover: 'pause-all'
});

const recentToasts = new Map<string, number>();

function normalizeMessage(value: unknown): string {
	if (value instanceof Error) return value.message.trim();
	if (typeof value === 'string') return value.trim();
	if (value === null || value === undefined) return '';
	return String(value).trim();
}

function pruneRecentToasts(now: number): void {
	for (const [key, timestamp] of recentToasts) {
		if (now - timestamp > 30_000) recentToasts.delete(key);
	}
}

function show(tone: ToastTone, value: unknown, options: ToastOptions = {}): string | null {
	if (typeof window === 'undefined') return null;

	const message = normalizeMessage(value);
	if (!message) return null;

	const now = Date.now();
	const dedupeKey = options.dedupeKey ?? `${tone}:${message}`;
	const dedupeWindow = options.dedupeWindow ?? 1200;
	const previousTimestamp = recentToasts.get(dedupeKey);
	if (previousTimestamp !== undefined && now - previousTimestamp < dedupeWindow) return null;

	recentToasts.set(dedupeKey, now);
	pruneRecentToasts(now);

	const activeToasts = get(toaster.states.toasts);
	for (const item of activeToasts.slice(
		0,
		Math.max(0, activeToasts.length - MAX_VISIBLE_TOASTS + 1)
	)) {
		toaster.helpers.removeToast(item.id);
	}

	return toaster.helpers.addToast({
		closeDelay: options.duration ?? DEFAULT_DURATION[tone],
		type: tone === 'error' ? 'foreground' : 'background',
		data: {
			tone,
			message,
			title: options.title
		}
	}).id;
}

/**
 * Shared Admin UI notification entry point. New actions should call this directly; the DOM bridge
 * in AdminToastHost keeps legacy inline messages compatible while pages are migrated over time.
 */
export const toast = {
	show,
	success: (message: unknown, options?: ToastOptions) => show('success', message, options),
	error: (message: unknown, options?: ToastOptions) => show('error', message, options),
	warning: (message: unknown, options?: ToastOptions) => show('warning', message, options),
	info: (message: unknown, options?: ToastOptions) => show('info', message, options),
	dismiss: (id: string) => toaster.helpers.removeToast(id),
	dismissAll: () => {
		for (const item of get(toaster.states.toasts)) toaster.helpers.removeToast(item.id);
	}
};

export const toastElements = toaster.elements;
export const toastState = toaster.states.toasts;
export const toastPortal = toaster.actions.portal;
