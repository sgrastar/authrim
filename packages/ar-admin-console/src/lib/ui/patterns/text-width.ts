/**
 * Full-width ↔ half-width text, as Japanese systems need it: letters, digits, symbols and
 * the space always; katakana only when asked (half-width katakana is still found in older
 * HR and bank systems, and full-width is what most apps expect).
 *
 * The katakana table is derived from Unicode itself (NFKC maps each half-width kana to its
 * full-width form), so there is no hand-typed table to get wrong. Voiced and semi-voiced
 * kana (ガ, パ) are two half-width characters (ｶﾞ, ﾊﾟ).
 */

const HALF_KANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ｡｢｣､･';
const VOICED = '゙';
const SEMI_VOICED = '゚';

/** Full-width katakana (and kana punctuation) → half-width. */
const TO_HALF_KANA: ReadonlyMap<string, string> = (() => {
	const table = new Map<string, string>([
		['゛', 'ﾞ'],
		['゜', 'ﾟ']
	]);
	for (const half of HALF_KANA) {
		const full = half.normalize('NFKC');
		table.set(full, half);
		for (const [mark, halfMark] of [
			[VOICED, 'ﾞ'],
			[SEMI_VOICED, 'ﾟ']
		]) {
			const marked = (full + mark).normalize('NFC');
			if (marked.length === 1) table.set(marked, half + halfMark);
		}
	}
	return table;
})();

const FULL_ASCII = /[！-～]/gu;
const HALF_ASCII = /[!-~]/gu;
const HALF_KANA_RUN = /[｡-ﾟ]+/gu;

export function toHalfwidth(text: string, katakana: boolean): string {
	let out = text
		.replace(FULL_ASCII, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replaceAll('　', ' ');
	if (katakana) out = [...out].map((c) => TO_HALF_KANA.get(c) ?? c).join('');
	return out;
}

export function toFullwidth(text: string, katakana: boolean): string {
	// Half-width kana first: its voiced marks combine with the kana before them (ｶﾞ → ガ).
	let out = katakana ? text.replace(HALF_KANA_RUN, (run) => run.normalize('NFKC')) : text;
	out = out
		.replace(HALF_ASCII, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
		.replaceAll(' ', '　');
	return out;
}
