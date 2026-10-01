export type JsonCheck =
	| { state: 'empty' }
	| { state: 'valid'; value: unknown }
	| { state: 'invalid'; line: number; column: number };

/**
 * Offset of the first syntax error in `text`, or -1 when it is valid JSON. Engines word
 * JSON.parse errors differently (and V8 often omits the position), so the position is found
 * with a small scanner that follows the JSON grammar instead of parsing error messages.
 */
export function findJsonError(text: string): number {
	let i = 0;
	const fail = (): never => {
		throw i;
	};
	const ws = () => {
		while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
	};
	const literal = (word: string) => {
		for (const ch of word) {
			if (text[i] !== ch) fail();
			i++;
		}
	};
	const string = () => {
		i++; // opening quote
		while (i < text.length) {
			const ch = text[i];
			if (ch === '"') return void i++;
			if (ch < ' ') fail();
			if (ch === '\\') {
				i++;
				const esc = text[i];
				if (esc === 'u') {
					for (let k = 1; k <= 4; k++) {
						if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) {
							i += k;
							fail();
						}
					}
					i += 5;
					continue;
				}
				if (!'"\\/bfnrt'.includes(esc ?? '')) fail();
			}
			i++;
		}
		fail();
	};
	const number = () => {
		const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
		if (!match || match[0] === '-') fail();
		i += match![0].length;
	};
	const value = (): void => {
		ws();
		const ch = text[i];
		if (ch === '{') {
			i++;
			ws();
			if (text[i] === '}') return void i++;
			for (;;) {
				ws();
				if (text[i] !== '"') fail();
				string();
				ws();
				if (text[i] !== ':') fail();
				i++;
				value();
				ws();
				if (text[i] === ',') {
					i++;
					continue;
				}
				if (text[i] === '}') return void i++;
				fail();
			}
		}
		if (ch === '[') {
			i++;
			ws();
			if (text[i] === ']') return void i++;
			for (;;) {
				value();
				ws();
				if (text[i] === ',') {
					i++;
					continue;
				}
				if (text[i] === ']') return void i++;
				fail();
			}
		}
		if (ch === '"') return string();
		if (ch === 't') return literal('true');
		if (ch === 'f') return literal('false');
		if (ch === 'n') return literal('null');
		if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
		fail();
	};
	try {
		value();
		ws();
		if (i < text.length) fail();
		return -1;
	} catch (offset) {
		return typeof offset === 'number' ? Math.min(offset, text.length) : 0;
	}
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
	const lines = text.slice(0, offset).split('\n');
	return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function checkJson(text: string): JsonCheck {
	if (text.trim() === '') return { state: 'empty' };
	try {
		return { state: 'valid', value: JSON.parse(text) };
	} catch {
		const offset = findJsonError(text);
		return { state: 'invalid', ...lineColumn(text, offset < 0 ? text.length : offset) };
	}
}

/** Pretty-prints valid JSON with two-space indentation; leaves invalid text untouched. */
export function formatJson(text: string): string {
	const result = checkJson(text);
	return result.state === 'valid' ? `${JSON.stringify(result.value, null, 2)}\n` : text;
}
