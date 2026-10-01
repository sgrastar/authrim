import { describe, expect, it } from 'vitest';
import { highlight, type CodeLanguage, type TokenType } from './highlight';

/** Compact view for assertions: only non-text tokens, as "type:text". */
function marks(code: string, language: CodeLanguage): string[] {
	return highlight(code, language)
		.filter((token) => token.type !== 'text')
		.map((token) => `${token.type}:${token.text}`);
}

/** Type of the first token containing `text` (adjacent tokens of one type are merged). */
const typeOf = (code: string, language: CodeLanguage, text: string): TokenType | undefined =>
	highlight(code, language).find((token) => token.text.includes(text))?.type;

describe('highlight', () => {
	it('never loses or reorders characters', () => {
		const samples: Array<[CodeLanguage, string]> = [
			['json', '{"a": [1, true, null, "x\\"y"]}'],
			['javascript', 'const f = (a) => a.b("s") // done\n/* c */ `t${1}`'],
			[
				'css',
				'@media (min-width: 640px) {\n  .a:hover > b { color: #fff !important; --x: calc(1px + 2%); }\n}'
			],
			[
				'xml',
				'<?xml version="1.0"?>\n<!-- c --><md:Entity id=\'1\' a="b">text &amp; <![CDATA[x]]></md:Entity>'
			],
			[
				'shell',
				'FOO=1 curl -sS --header "A: $TOKEN" https://x | jq \'.a\' # note\nif [ -f x ]; then echo ${HOME}; fi'
			]
		];
		for (const [language, code] of samples) {
			expect(
				highlight(code, language)
					.map((t) => t.text)
					.join(''),
				language
			).toBe(code);
		}
	});

	it('marks JSON keys apart from string values', () => {
		expect(marks('{"name": "Acme", "n": 2, "ok": true}', 'json')).toEqual([
			'punct:{',
			'property:"name"',
			'punct::',
			'string:"Acme"',
			'punct:,',
			'property:"n"',
			'punct::',
			'number:2',
			'punct:,',
			'property:"ok"',
			'punct::',
			'literal:true',
			'punct:}'
		]);
	});

	it('knows JavaScript keywords, calls, properties and comments', () => {
		const code = 'const user = await api.get("u") // fetch';
		expect(typeOf(code, 'javascript', 'const')).toBe('keyword');
		expect(typeOf(code, 'javascript', 'get')).toBe('function');
		expect(typeOf(code, 'javascript', 'user')).toBe('text');
		expect(typeOf(code, 'javascript', '// fetch')).toBe('comment');
	});

	it('separates CSS selectors from declarations', () => {
		const code = '.btn:hover { color: var(--primary); }';
		expect(typeOf(code, 'css', '.btn')).toBe('tag');
		expect(typeOf(code, 'css', 'color')).toBe('property');
		expect(typeOf(code, 'css', 'var')).toBe('function');
		const nested = '@media (min-width: 640px) {\n  .card > .logo { margin: 0; }\n}';
		expect(typeOf(nested, 'css', '.card > .logo')).toBe('tag');
		expect(typeOf(nested, 'css', 'margin')).toBe('property');
	});

	it('splits XML into tags, attributes and values', () => {
		const code = '<md:SPSSODescriptor protocol="saml">';
		expect(marks(code, 'xml')).toEqual([
			'punct:<',
			'tag:md:SPSSODescriptor',
			'attr:protocol',
			'punct:=',
			'string:"saml"',
			'punct:>'
		]);
		expect(marks('<?xml version="1.0"?>', 'xml').slice(0, 2)).toEqual(['punct:<?', 'tag:xml']);
	});

	it('treats the first word of a shell command as the command', () => {
		const code = 'curl -X POST "$URL" | jq .id';
		expect(typeOf(code, 'shell', 'curl')).toBe('function');
		expect(typeOf(code, 'shell', '-X')).toBe('attr');
		expect(typeOf(code, 'shell', 'jq')).toBe('function');
		expect(typeOf(code, 'shell', '"$URL"')).toBe('string');
		expect(typeOf('cat ./$ENV_NAME/config', 'shell', '$ENV_NAME')).toBe('variable');
	});
});
