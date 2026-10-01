/**
 * Pseudo-localisation: English turned into "[Šåvé çĥåñĝéš one two]" so layout and
 * translation problems show up without a translator. For checking the UI in Storybook only —
 * never offered to admins.
 *
 * - Accented letters: text that stays plain English (or Japanese) never went through `t()`.
 * - Longer text (real translations run 30–100 % longer than English, short labels the most):
 *   finds truncation and overflow.
 * - Brackets at both ends: a missing `]` means the text was cut off there.
 * - Diacritics above and below the letters: find line heights that clip.
 * `{name}` placeholders are kept, so values passed to `t()` still appear unchanged.
 */

const ACCENTED: Record<string, string> = {
	a: 'å',
	b: 'ƀ',
	c: 'ç',
	d: 'ð',
	e: 'é',
	f: 'ƒ',
	g: 'ĝ',
	h: 'ĥ',
	i: 'î',
	j: 'ĵ',
	k: 'ķ',
	l: 'ļ',
	m: 'ɱ',
	n: 'ñ',
	o: 'ö',
	p: 'þ',
	q: 'ǫ',
	r: 'ŕ',
	s: 'š',
	t: 'ţ',
	u: 'û',
	v: 'ṽ',
	w: 'ŵ',
	x: 'ẋ',
	y: 'ý',
	z: 'ž',
	A: 'Å',
	B: 'Ɓ',
	C: 'Ç',
	D: 'Ð',
	E: 'É',
	F: 'Ƒ',
	G: 'Ĝ',
	H: 'Ĥ',
	I: 'Î',
	J: 'Ĵ',
	K: 'Ķ',
	L: 'Ļ',
	M: 'Ṁ',
	N: 'Ñ',
	O: 'Ö',
	P: 'Þ',
	Q: 'Ǫ',
	R: 'Ŕ',
	S: 'Š',
	T: 'Ţ',
	U: 'Û',
	V: 'Ṽ',
	W: 'Ŵ',
	X: 'Ẋ',
	Y: 'Ý',
	Z: 'Ž'
};

/** Padding words: they wrap like real words, so line breaking is exercised too. */
const PADDING = ['öñé', 'ţŵö', 'ţĥŕéé', 'ƒöûŕ', 'ƒîṽé', 'šîẋ', 'šéṽéñ', 'éîĝĥţ', 'ñîñé', 'ţéñ'];

const PLACEHOLDER = /(\{\w+\})/;

/** How much longer a translation of this length tends to be (short labels grow the most). */
function growth(length: number): number {
	if (length <= 10) return 0.8;
	if (length <= 20) return 0.6;
	if (length <= 50) return 0.4;
	return 0.3;
}

export function pseudoLocalize(text: string): string {
	if (text === '') return text;
	const parts = text.split(PLACEHOLDER);
	const body = parts
		.map((part) =>
			PLACEHOLDER.test(part) ? part : [...part].map((c) => ACCENTED[c] ?? c).join('')
		)
		.join('');
	const visible = parts.filter((part) => !PLACEHOLDER.test(part)).join('').length;
	const target = Math.ceil(visible * growth(visible));
	const padding: string[] = [];
	for (let length = 0, i = 0; length < target; i++) {
		const word = PADDING[i % PADDING.length];
		padding.push(word);
		length += word.length + 1;
	}
	return `[${body}${padding.length ? ` ${padding.join(' ')}` : ''}]`;
}
