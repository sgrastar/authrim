/**
 * The footer text may carry links written as `<a href="https://…">text</a>`. The text is split
 * into plain parts and link parts instead of being injected as HTML, so nothing else in it is ever
 * read as markup, and only http(s) addresses become links.
 */
export type FooterPart = { text: string } | { text: string; href: string };

const LINK = /<a\s+href\s*=\s*(["'])(https?:\/\/[^"'\s<>]+)\1\s*>([^<]*)<\/a>/gi;

export function parseFooter(source: string): FooterPart[] {
	const parts: FooterPart[] = [];
	let from = 0;
	for (const match of source.matchAll(LINK)) {
		if (match.index > from) parts.push({ text: source.slice(from, match.index) });
		parts.push({ href: match[2], text: match[3] });
		from = match.index + match[0].length;
	}
	if (from < source.length) parts.push({ text: source.slice(from) });
	return parts;
}
