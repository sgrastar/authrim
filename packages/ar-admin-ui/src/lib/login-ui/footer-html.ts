import { escapeHtml } from '$lib/utils/sanitize';

export function sanitizeFooterHtml(value: string | null | undefined): string {
	if (!value) return '';

	let output = '';
	let cursor = 0;
	let anchorOpen = false;
	const tagPattern = /<[^>]*>/g;

	for (const match of value.matchAll(tagPattern)) {
		output += escapeHtml(value.slice(cursor, match.index));
		const tag = match[0];

		if (/^<\/a\s*>$/i.test(tag)) {
			if (anchorOpen) {
				output += '</a>';
				anchorOpen = false;
			}
		} else if (!anchorOpen) {
			const anchorMatch = tag.match(/^<a\s+([^>]*)>$/i);
			const hrefMatch = anchorMatch?.[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
			const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
			const safeHref = sanitizeFooterHref(href);
			if (safeHref) {
				output += `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">`;
				anchorOpen = true;
			}
		}

		cursor = (match.index ?? 0) + tag.length;
	}

	output += escapeHtml(value.slice(cursor));
	if (anchorOpen) output += '</a>';
	return output;
}

function sanitizeFooterHref(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

	try {
		const url = new URL(trimmed);
		return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
			? trimmed
			: '';
	} catch {
		return '';
	}
}
