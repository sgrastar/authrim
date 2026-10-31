/**
 * Console notifications. Same behaviour as the legacy Admin UI toaster (ar-admin-ui
 * src/lib/toast.ts): four tones with their own durations, duplicate suppression, at most four
 * on screen, and errors announced assertively. Hovering pauses every timer.
 */
export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
	title?: string;
	/** Milliseconds before closing. 0 keeps the toast until dismissed. */
	duration?: number;
	dedupeKey?: string;
	dedupeWindow?: number;
}

export interface ToastItem {
	id: string;
	tone: ToastTone;
	message: string;
	title?: string;
	duration: number;
	/** Time left when paused; counts down while running. */
	remaining: number;
	startedAt: number;
}

export const MAX_VISIBLE_TOASTS = 4;
export const DEFAULT_DURATION: Record<ToastTone, number> = {
	success: 5000,
	error: 8000,
	warning: 7000,
	info: 5000
};

let items = $state<ToastItem[]>([]);
let paused = $state(false);
// Bookkeeping only; the UI never reads these, so they are deliberately not reactive.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const recent = new Map<string, number>();
let sequence = 0;

function normalize(value: unknown): string {
	if (value instanceof Error) return value.message.trim();
	if (typeof value === 'string') return value.trim();
	if (value === null || value === undefined) return '';
	return String(value).trim();
}

function schedule(item: ToastItem): void {
	clearTimeout(timers.get(item.id));
	if (item.duration === 0 || paused) return;
	item.startedAt = Date.now();
	timers.set(
		item.id,
		setTimeout(() => dismiss(item.id), item.remaining)
	);
}

function dismiss(id: string): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
	items = items.filter((item) => item.id !== id);
}

function show(tone: ToastTone, value: unknown, options: ToastOptions = {}): string | null {
	const message = normalize(value);
	if (!message) return null;

	const now = Date.now();
	const key = options.dedupeKey ?? `${tone}:${message}`;
	const last = recent.get(key);
	if (last !== undefined && now - last < (options.dedupeWindow ?? 1200)) return null;
	recent.set(key, now);
	for (const [k, at] of recent) if (now - at > 30_000) recent.delete(k);

	const duration = options.duration ?? DEFAULT_DURATION[tone];
	const item: ToastItem = {
		id: `toast-${++sequence}`,
		tone,
		message,
		title: options.title,
		duration,
		remaining: duration,
		startedAt: now
	};
	const overflow = items.length - MAX_VISIBLE_TOASTS + 1;
	for (const old of items.slice(0, Math.max(0, overflow))) dismiss(old.id);
	items = [...items, item];
	schedule(items[items.length - 1]);
	return item.id;
}

export const toast = {
	get items(): readonly ToastItem[] {
		return items;
	},
	get paused(): boolean {
		return paused;
	},
	show,
	success: (message: unknown, options?: ToastOptions) => show('success', message, options),
	error: (message: unknown, options?: ToastOptions) => show('error', message, options),
	warning: (message: unknown, options?: ToastOptions) => show('warning', message, options),
	info: (message: unknown, options?: ToastOptions) => show('info', message, options),
	dismiss,
	dismissAll(): void {
		for (const item of items) dismiss(item.id);
	},
	/** Hover or focus inside the stack: stop every countdown so nothing closes while being read. */
	pause(): void {
		if (paused) return;
		paused = true;
		const now = Date.now();
		for (const item of items) {
			clearTimeout(timers.get(item.id));
			if (item.duration > 0) item.remaining = Math.max(0, item.remaining - (now - item.startedAt));
		}
	},
	resume(): void {
		if (!paused) return;
		paused = false;
		for (const item of items) schedule(item);
	}
};
