/**
 * Small tokenizers for the languages admins paste into the console. They colour code; they do
 * not validate it. Output is a list of tokens rendered as text nodes, so nothing the user types
 * is ever interpreted as HTML.
 */
export type CodeLanguage = 'json' | 'javascript' | 'css' | 'xml' | 'shell';

export type TokenType =
	| 'text'
	| 'comment'
	| 'string'
	| 'number'
	| 'keyword'
	| 'literal'
	| 'property'
	| 'tag'
	| 'attr'
	| 'function'
	| 'variable'
	| 'punct';

export interface Token {
	type: TokenType;
	text: string;
}

type Rule = [TokenType, RegExp];

/** Runs sticky regexes at each position; unmatched characters become plain text. */
function scan(
	code: string,
	rulesAt: (state: ScanState) => readonly Rule[],
	state: ScanState
): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const push = (type: TokenType, text: string) => {
		const last = tokens[tokens.length - 1];
		if (last && last.type === type) last.text += text;
		else tokens.push({ type, text });
	};
	outer: while (i < code.length) {
		for (const [type, pattern] of rulesAt(state)) {
			pattern.lastIndex = i;
			const match = pattern.exec(code);
			if (match && match[0].length > 0) {
				push(type, match[0]);
				state.after(type, match[0]);
				i += match[0].length;
				continue outer;
			}
		}
		push('text', code[i]);
		state.after('text', code[i]);
		i++;
	}
	return tokens;
}

interface ScanState {
	after(type: TokenType, text: string): void;
}

const stateless: ScanState = { after() {} };

const JSON_RULES: Rule[] = [
	['property', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y],
	['string', /"(?:[^"\\\n]|\\.)*"?/y],
	['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
	['literal', /\b(?:true|false|null)\b/y],
	['punct', /[{}[\],:]/y]
];

const JS_KEYWORDS =
	'async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|switch|this|throw|try|typeof|var|void|while|yield';
const JS_RULES: Rule[] = [
	['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
	['string', /'(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?|`(?:[^`\\]|\\.)*`?/y],
	['number', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b/y],
	['keyword', new RegExp(`\\b(?:${JS_KEYWORDS})\\b`, 'y')],
	['literal', /\b(?:true|false|null|undefined|NaN|Infinity)\b/y],
	['function', /[A-Za-z_$][\w$]*(?=\s*\()/y],
	['property', /(?<=\.)[A-Za-z_$][\w$]*/y],
	['text', /[A-Za-z_$][\w$]*/y],
	['punct', /[{}[\]();,.:?]|=>|[=!<>]=?=?|[+\-*/%&|^~]/y]
];

const CSS_OUTSIDE: Rule[] = [
	['comment', /\/\*[\s\S]*?(?:\*\/|$)/y],
	['keyword', /@[\w-]+/y],
	['string', /'(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?/y],
	['tag', /[.#]?[A-Za-z_-][\w-]*|::?[\w-]+|\*/y],
	['punct', /[{}(),>+~[\]=:]/y]
];
const CSS_INSIDE: Rule[] = [
	['comment', /\/\*[\s\S]*?(?:\*\/|$)/y],
	// A nested rule (inside @media/@supports): the selector runs up to "{" with no ";" or "}".
	['tag', /[.#:\w[\]="'>+~*,()-][^{};]*(?=\{)/y],
	['property', /--?[A-Za-z_][\w-]*(?=\s*:)|[a-z-]+(?=\s*:)/y],
	['string', /'(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?/y],
	['number', /#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:%|[a-z]+)?/y],
	['function', /[\w-]+(?=\()/y],
	['keyword', /!important\b|@[\w-]+/y],
	['literal', /\b[a-z-]+\b/y],
	['punct', /[{}();:,/]/y]
];

function cssState() {
	let depth = 0;
	return {
		after(type: TokenType, text: string) {
			if (type !== 'punct') return;
			for (const ch of text) {
				if (ch === '{') depth++;
				if (ch === '}') depth = Math.max(0, depth - 1);
			}
		},
		get depth() {
			return depth;
		}
	};
}

const XML_TEXT: Rule[] = [
	['comment', /<!--[\s\S]*?(?:-->|$)/y],
	['string', /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y],
	['punct', /<\?|<\/?/y],
	['keyword', /&[#\w]+;/y]
];
const XML_TAG_NAME: Rule[] = [['tag', /[\w:.-]+/y]];
const XML_IN_TAG: Rule[] = [
	['attr', /[\w:.-]+(?=\s*=)|[\w:.-]+/y],
	['string', /"[^"]*"?|'[^']*'?/y],
	['punct', /\/?>|\?>|=/y]
];

function xmlState() {
	let mode: 'text' | 'name' | 'tag' = 'text';
	return {
		after(type: TokenType, text: string) {
			if (mode === 'text' && type === 'punct') mode = 'name';
			else if (mode === 'name' && type === 'tag') mode = 'tag';
			else if (mode === 'name') mode = 'tag';
			else if (mode === 'tag' && type === 'punct' && text.endsWith('>')) mode = 'text';
		},
		get mode() {
			return mode;
		}
	};
}

const SHELL_KEYWORDS =
	'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|export|local|return';
const SHELL_ARGS: Rule[] = [
	['comment', /(?<=^|\s)#[^\n]*/y],
	['string', /'[^']*'?|"(?:[^"\\]|\\.)*"?/y],
	['variable', /\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[@*#?$!0-9-]/y],
	['attr', /(?<=^|\s)--?[\w-]+(?:=)?/y],
	['number', /(?<=^|\s)\d+(?=\s|$)/y],
	['punct', /\|\|?|&&|;|>>?|<|\\(?=\n)/y],
	['text', /[^\s'"$|&;<>\\#]+/y]
];
const SHELL_COMMAND: Rule[] = [
	['comment', /#[^\n]*/y],
	['keyword', new RegExp(`(?:${SHELL_KEYWORDS})(?=\\s|$|;)`, 'y')],
	['variable', /[A-Za-z_]\w*(?==)/y],
	['function', /[\w./-]+/y]
];

function shellState() {
	let atCommand = true;
	return {
		after(type: TokenType, text: string) {
			if (type === 'punct' && /^(?:\|\|?|&&|;)$/.test(text)) atCommand = true;
			else if (type === 'text' && text.includes('\n')) atCommand = true;
			else if (type === 'function' || (type === 'keyword' && text !== 'export'))
				atCommand = type === 'keyword';
			else if (type === 'variable' && atCommand) atCommand = true;
			else if (type !== 'text' || /\S/.test(text)) atCommand = false;
		},
		get atCommand() {
			return atCommand;
		}
	};
}

export function highlight(code: string, language: CodeLanguage): Token[] {
	switch (language) {
		case 'json':
			return scan(code, () => JSON_RULES, stateless);
		case 'javascript':
			return scan(code, () => JS_RULES, stateless);
		case 'css': {
			const state = cssState();
			return scan(code, () => (state.depth > 0 ? CSS_INSIDE : CSS_OUTSIDE), state);
		}
		case 'xml': {
			const state = xmlState();
			return scan(
				code,
				() =>
					state.mode === 'text' ? XML_TEXT : state.mode === 'name' ? XML_TAG_NAME : XML_IN_TAG,
				state
			);
		}
		case 'shell': {
			const state = shellState();
			return scan(
				code,
				() => (state.atCommand ? [...SHELL_COMMAND, ...SHELL_ARGS] : SHELL_ARGS),
				state
			);
		}
	}
}
