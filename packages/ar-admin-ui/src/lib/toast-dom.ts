import type { ToastTone } from '$lib/toast';

// Legacy message containers are centralized here so existing and newly discovered page patterns can
// be covered without duplicating MutationObserver or toast logic in individual routes.
export const SUCCESS_TOAST_SOURCE_SELECTOR = [
	"[data-admin-toast='success']",
	'.alert.alert-success',
	'.alert.alert--success',
	'.alert.success',
	'.message.success',
	'.notice.success'
].join(',');

export const ERROR_TOAST_SOURCE_SELECTOR = [
	"[data-admin-toast='error']",
	'.alert.alert-error',
	'.alert.alert--error',
	'.alert.alert-danger',
	'.alert.error',
	'.message.error',
	'.notice.error',
	'.form-message.error',
	'.modal-alert.error',
	'.error-message',
	'.tree-container > .error',
	'.error-banner',
	'.error-container',
	'.error-state',
	'.empty-state.error',
	'.flow-empty--error',
	'.form-error',
	'.inline-error',
	'.modal-error',
	'.event-error',
	'.guide-error',
	'.operation-error-banner',
	'.passkeys-error',
	'.shard-config-error',
	'.page-alert[role="alert"]',
	'.create-error[role="alert"]',
	'.sr-only[role="alert"]',
	'.user-menu-language__error',
	'.language-error'
].join(',');

export const TOAST_SOURCE_SELECTOR = `${SUCCESS_TOAST_SOURCE_SELECTOR},${ERROR_TOAST_SOURCE_SELECTOR}`;

export interface ToastSource {
	element: Element;
	tone: Extract<ToastTone, 'success' | 'error'>;
	message: string;
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export function readToastSource(element: Element): ToastSource | null {
	if (element.closest('[data-admin-toast-viewport]')) return null;
	if (element.closest('[data-admin-toast-ignore]')) return null;

	const tone = element.matches(ERROR_TOAST_SOURCE_SELECTOR)
		? 'error'
		: element.matches(SUCCESS_TOAST_SOURCE_SELECTOR)
			? 'success'
			: null;
	if (!tone) return null;

	const explicitMessage = element.getAttribute('data-admin-toast-message');
	const message = normalizeText(explicitMessage ?? element.textContent ?? '');
	if (!message) return null;

	return { element, tone, message };
}

export function findToastSources(root: ParentNode): ToastSource[] {
	const candidates: Element[] = [];
	if (root instanceof Element && root.matches(TOAST_SOURCE_SELECTOR)) candidates.push(root);
	candidates.push(...root.querySelectorAll(TOAST_SOURCE_SELECTOR));
	return candidates.flatMap((element) => {
		const source = readToastSource(element);
		return source ? [source] : [];
	});
}
