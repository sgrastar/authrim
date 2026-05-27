import type { DeterministicIdInput, RedactionSafeIdPart } from './types';

export function createDeterministicId(input: DeterministicIdInput): string {
  const semanticPath = input.semanticPath.map(normalizeIdPart).filter(Boolean).join('.');
  const hash = shortHash([input.kind, ...input.semanticPath, ...(input.contentHashParts ?? [])]);
  return `${input.kind}.${semanticPath || 'unknown'}.${hash}`;
}

export function shortHash(parts: RedactionSafeIdPart[]): string {
  const source = parts.map((part) => String(part)).join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function normalizeIdPart(value: RedactionSafeIdPart): string {
  const input = String(value).trim().toLowerCase();
  let normalized = '';
  let previousWasSeparator = true;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const isAsciiLetter = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';

    if (isAsciiLetter || isDigit) {
      normalized += char;
      previousWasSeparator = false;
      continue;
    }

    if (!previousWasSeparator) {
      normalized += '-';
      previousWasSeparator = true;
    }
  }

  return previousWasSeparator ? normalized.slice(0, -1) : normalized;
}
