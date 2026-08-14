import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

export type MatrixRow = Record<string, string>;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }

    cell += char;
  }

  cells.push(cell);
  return cells;
}

export function parseMatrixCsv<T extends MatrixRow = MatrixRow>(csv: string): T[] {
  const normalized = csv
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line, lineIndex) => {
    const cells = parseCsvLine(line);
    if (cells.length !== headers.length) {
      throw new Error(
        `Invalid CSV row ${lineIndex + 2}: expected ${headers.length} cells, got ${cells.length}`
      );
    }

    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])) as T;
  });
}

export function loadMatrixCsv<T extends MatrixRow = MatrixRow>(filename: string): T[] {
  const csv = readFileSync(join(FIXTURE_DIR, filename), 'utf8');
  return parseMatrixCsv<T>(csv);
}
