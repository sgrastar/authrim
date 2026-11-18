/**
 * The Login UI page's custom content blocks: the setting `login-ui.custom_blocks` (a JSON array)
 * as the page edits it, and back. The shape and the limits are the Login UI's
 * (`@authrim/ar-lib-core/types/login-ui-custom-blocks`); a block the screens would leave out
 * (an empty paragraph, an address of the wrong kind) is shown with its problem and holds the save.
 */
import {
	isLoginUICustomBlockPosition,
	isLoginUICustomBlockType,
	LOGIN_UI_CUSTOM_BLOCK_CONTENT_MAX,
	LOGIN_UI_CUSTOM_BLOCK_URL_MAX,
	LOGIN_UI_CUSTOM_BLOCKS_MAX,
	type LoginUICustomBlock,
	type LoginUICustomBlockType
} from '@authrim/ar-lib-core/types/login-ui-custom-blocks';

export type CustomBlock = LoginUICustomBlock;
export const BLOCKS_MAX = LOGIN_UI_CUSTOM_BLOCKS_MAX;
export const BLOCK_CONTENT_MAX = LOGIN_UI_CUSTOM_BLOCK_CONTENT_MAX;
export const BLOCK_URL_MAX = LOGIN_UI_CUSTOM_BLOCK_URL_MAX;

/** A new, empty block as the editor adds one. */
export function newBlock(): CustomBlock {
	return { position: 'below-form', type: 'text', content: '' };
}

/** The blocks saved in the setting: those with a known place and kind, as the screens read them. */
export function parseBlocks(value: unknown): CustomBlock[] {
	if (typeof value !== 'string' || !value.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const blocks: CustomBlock[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const candidate = entry as Record<string, unknown>;
		if (!isLoginUICustomBlockPosition(candidate.position)) continue;
		if (!isLoginUICustomBlockType(candidate.type)) continue;
		const block: CustomBlock = {
			position: candidate.position,
			type: candidate.type,
			content: typeof candidate.content === 'string' ? candidate.content : ''
		};
		if (typeof candidate.url === 'string') block.url = candidate.url;
		if (typeof candidate.alt === 'string') block.alt = candidate.alt;
		blocks.push(block);
	}
	return blocks.slice(0, BLOCKS_MAX);
}

/** The setting to save: the blocks as JSON, each with only the fields its kind uses; '' for none. */
export function serializeBlocks(blocks: readonly CustomBlock[]): string {
	if (blocks.length === 0) return '';
	return JSON.stringify(
		blocks.map((block) => {
			const out: CustomBlock = {
				position: block.position,
				type: block.type,
				content: block.content.trim()
			};
			if (block.type === 'link') out.url = block.url?.trim() ?? '';
			if (block.type === 'image' && block.alt?.trim()) out.alt = block.alt.trim();
			return out;
		})
	);
}

/**
 * What the screens accept as an image address (their `isValidImageUrl`): https, a path on the
 * screens' own origin (`/api/assets/…`), or a raster data: URI (never SVG).
 */
export function isImageAddress(value: string): boolean {
	if (!value || value.startsWith('//')) return false;
	if (value.startsWith('/')) return true;
	if (/^data:image\/svg/i.test(value)) return false;
	if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp|ico|avif);base64,/i.test(value)) return true;
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

/** What the screens accept as a link address: http or https. */
export function isLinkAddress(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === 'https:' || protocol === 'http:';
	} catch {
		return false;
	}
}

export type BlockProblem = 'content' | 'contentLong' | 'url' | 'urlLong';

/** Why the screens would leave the block out, or null when they would show it. */
export function blockProblem(block: CustomBlock): BlockProblem | null {
	const content = block.content.trim();
	if (!content) return 'content';
	if (block.type === 'image') {
		if (content.length > BLOCK_URL_MAX) return 'contentLong';
		return isImageAddress(content) ? null : 'content';
	}
	if (content.length > BLOCK_CONTENT_MAX) return 'contentLong';
	if (block.type === 'link') {
		const url = block.url?.trim() ?? '';
		if (!url) return 'url';
		if (url.length > BLOCK_URL_MAX) return 'urlLong';
		return isLinkAddress(url) ? null : 'url';
	}
	return null;
}

/** The fields a kind of block asks for, besides its place and kind. */
export function fieldsOf(type: LoginUICustomBlockType): {
	content: 'text' | 'address' | 'label';
	extra: 'url' | 'alt' | null;
} {
	switch (type) {
		case 'image':
			return { content: 'address', extra: 'alt' };
		case 'link':
			return { content: 'label', extra: 'url' };
		default:
			return { content: 'text', extra: null };
	}
}
