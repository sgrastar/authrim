import { failTransform, TRANSFORM_LIMITS } from './transform-safety';

/** Bounded replacement, including JS $1/$&/prefix/suffix substitutions, before allocation. */
export function boundedReplace(
  text: string,
  pattern: RegExp,
  replacement: string,
  literal = false
): string {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 2; // String framing in measureTransformValue.
  const append = (chunk: string) => {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > TRANSFORM_LIMITS.valueBytes) failTransform('transform.limit_exceeded');
    chunks.push(chunk);
  };
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    append(text.slice(cursor, index));
    if (literal) {
      append(replacement);
    } else {
      let start = 0;
      for (let i = 0; i < replacement.length; i++) {
        if (replacement[i] !== '$') continue;
        const next = replacement[i + 1];
        let substitution: string | undefined;
        let consumed = 1;
        if (next === '$') substitution = '$';
        else if (next === '&') substitution = match[0];
        else if (next === '`') substitution = text.slice(0, index);
        else if (next === "'") substitution = text.slice(index + match[0].length);
        else if (next && /[0-9]/u.test(next)) {
          let n = Number(next);
          const second = replacement[i + 2];
          if (
            second &&
            /[0-9]/u.test(second) &&
            n * 10 + Number(second) > 0 &&
            n * 10 + Number(second) < match.length
          ) {
            n = n * 10 + Number(second);
            consumed = 2;
          }
          if (n > 0 && n < match.length) substitution = match[n] ?? '';
        }
        if (substitution === undefined) continue;
        append(replacement.slice(start, i));
        append(substitution);
        i += consumed;
        start = i + 1;
      }
      append(replacement.slice(start));
    }
    cursor = index + match[0].length;
  }
  append(text.slice(cursor));
  return chunks.join('');
}
