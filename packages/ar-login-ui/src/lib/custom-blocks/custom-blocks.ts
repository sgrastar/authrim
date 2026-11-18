/**
 * The tenant's own content around the sign-in screens: the setting `login-ui.custom_blocks`, a
 * JSON array the API parses and hands over as `appearance.customBlocks`. Each block says where it
 * goes (`position`), what it is (`type`) and its `content`:
 *   text   — a paragraph, shown as written
 *   html   — a paragraph that may hold links written as `<a href="https://…">…</a>`; any other
 *            tag is removed and its text kept (the footer's rule, `sanitizeFooterHtml`)
 *   image  — `content` is the image address (https, or a raster data: URI), `alt` its description
 *   link   — `content` is the label, `url` the address (http or https)
 * A block that is not well formed is left out, never shown half; at most MAX_CUSTOM_BLOCKS show.
 * The shape and the limits are shared with the console (`@authrim/ar-lib-core`).
 */
import {
	isLoginUICustomBlockPosition,
	isLoginUICustomBlockType,
	LOGIN_UI_CUSTOM_BLOCK_CONTENT_MAX,
	LOGIN_UI_CUSTOM_BLOCK_POSITIONS,
	LOGIN_UI_CUSTOM_BLOCK_TYPES,
	LOGIN_UI_CUSTOM_BLOCK_URL_MAX,
	LOGIN_UI_CUSTOM_BLOCKS_MAX,
	type LoginUICustomBlock,
	type LoginUICustomBlockPosition,
	type LoginUICustomBlockType
} from '@authrim/ar-lib-core/types/login-ui-custom-blocks';
import { isValidImageUrl, isValidLinkUrl } from '#lib/utils/url-validation.js';

export const CUSTOM_BLOCK_POSITIONS = LOGIN_UI_CUSTOM_BLOCK_POSITIONS;
export const CUSTOM_BLOCK_TYPES = LOGIN_UI_CUSTOM_BLOCK_TYPES;
export type CustomBlockPosition = LoginUICustomBlockPosition;
export type CustomBlockType = LoginUICustomBlockType;
export type CustomBlock = LoginUICustomBlock;

export const MAX_CUSTOM_BLOCKS = LOGIN_UI_CUSTOM_BLOCKS_MAX;
export const MAX_CUSTOM_BLOCK_CONTENT = LOGIN_UI_CUSTOM_BLOCK_CONTENT_MAX;
export const MAX_CUSTOM_BLOCK_URL = LOGIN_UI_CUSTOM_BLOCK_URL_MAX;

/** One block off the wire, or null when it cannot be shown as meant. */
export function readCustomBlock(entry: unknown): CustomBlock | null {
	if (!entry || typeof entry !== 'object') return null;
	const candidate = entry as Record<string, unknown>;
	if (
		!isLoginUICustomBlockPosition(candidate.position) ||
		!isLoginUICustomBlockType(candidate.type)
	)
		return null;
	const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
	const limit = candidate.type === 'image' ? MAX_CUSTOM_BLOCK_URL : MAX_CUSTOM_BLOCK_CONTENT;
	if (!content || content.length > limit) return null;
	const block: CustomBlock = { position: candidate.position, type: candidate.type, content };
	switch (block.type) {
		case 'image': {
			if (!isValidImageUrl(content)) return null;
			if (typeof candidate.alt === 'string' && candidate.alt.trim())
				block.alt = candidate.alt.trim();
			return block;
		}
		case 'link': {
			const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
			if (url.length > MAX_CUSTOM_BLOCK_URL || !isValidLinkUrl(url)) return null;
			block.url = url;
			return block;
		}
		default:
			return block;
	}
}

/** The blocks to show, in the order given, the ill-formed ones left out. */
export function safeCustomBlocks(value: unknown): CustomBlock[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(readCustomBlock)
		.filter((block): block is CustomBlock => block !== null)
		.slice(0, MAX_CUSTOM_BLOCKS);
}
