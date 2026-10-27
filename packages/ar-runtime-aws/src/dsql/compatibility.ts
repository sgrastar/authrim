/** Static triage only. This module never executes, rewrites, or approves SQL. */
export interface DsqlCompatibilitySource {
  path: string;
  /** SQL source, or TypeScript source when kind is typescript. */
  sql: string;
  kind?: 'sql' | 'typescript';
}

export interface DsqlCompatibilityFinding {
  path: string;
  line: number;
  code: string;
  severity: 'blocker' | 'manual-review';
  /** Fixed diagnostic text; source SQL and values are never copied here. */
  message: string;
}

export interface DsqlCompatibilityReport {
  schemaVersion: 1;
  assessment: 'static-triage';
  fullRuntimeReady: false;
  sourcesScanned: number;
  findings: DsqlCompatibilityFinding[];
  limitations: string[];
  requiredWork: string[];
}

interface SourceSegment {
  text: string;
  offset: number;
}

const blank = (text: string): string => text.replace(/[^\n\r]/g, ' ');

/** Preserve offsets while excluding comments, values, and quoted identifiers. */
function sqlCode(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      result += blank(text.slice(start, i));
    } else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      result += blank(text.slice(start, i));
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i++];
      while (i < text.length) {
        if (text[i] === '\\') i += Math.min(2, text.length - i);
        else if (text[i] === quote && text[i + 1] === quote) i += 2;
        else if (text[i++] === quote) break;
      }
      result += blank(text.slice(start, i));
    } else {
      const delimiter = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const bodyStart = i + delimiter.length;
        const closing = text.indexOf(delimiter, bodyStart);
        const bodyEnd = closing < 0 ? text.length : closing;
        // Inspect procedural bodies, but do not treat arbitrary dollar-quoted values as SQL.
        const procedural = /\bDO\s*$/i.test(result) || /\bAS\s*$/i.test(result);
        const body = text.slice(bodyStart, bodyEnd);
        result += blank(delimiter) + (procedural ? sqlCode(body) : blank(body));
        if (closing >= 0) result += blank(delimiter);
        i = closing < 0 ? text.length : closing + delimiter.length;
      } else result += text[i++];
    }
  }
  return result;
}

/**
 * Inspect literal SQL in TS without treating TS comments as executable SQL. This is not
 * a TypeScript parser: computed SQL, interpolation and call ordering need manual review.
 */
function typescriptLiterals(text: string): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i++];
      const start = i;
      while (i < text.length) {
        if (text[i] === '\\') i += Math.min(2, text.length - i);
        else if (text[i] === quote) break;
        else i += 1;
      }
      segments.push({ text: text.slice(start, i), offset: start });
      if (i < text.length) i += 1;
    } else i += 1;
  }
  return segments;
}

const RULES: ReadonlyArray<{
  code: string;
  severity: DsqlCompatibilityFinding['severity'];
  pattern: RegExp;
  message: string;
}> = [
  {
    code: 'procedural-language',
    severity: 'blocker',
    pattern: /\bLANGUAGE\s+plpgsql\b/gi,
    message: 'PL/pgSQL requires an application-level replacement; do not remove its invariants.',
  },
  {
    code: 'trigger',
    severity: 'blocker',
    pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/gi,
    message: 'Database triggers require an equivalent, verified application-level operation.',
  },
  {
    code: 'trigger-function',
    severity: 'blocker',
    pattern: /\bRETURNS\s+trigger\b/gi,
    message: 'Trigger functions cannot be imported unchanged into Aurora DSQL.',
  },
  {
    code: 'anonymous-procedural-block',
    severity: 'blocker',
    pattern: /\bDO\s+(?=(?:BEGIN|DECLARE)\b)/gi,
    message: 'Anonymous procedural blocks require a separate, resumable initialization path.',
  },
  {
    code: 'advisory-lock',
    severity: 'blocker',
    pattern: /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?\s*\(/gi,
    message: 'Advisory-lock coordination needs a DSQL-compatible concurrency design.',
  },
  {
    code: 'serializable-isolation',
    severity: 'blocker',
    pattern: /\b(?:ISOLATION\s+LEVEL\s+)?SERIALIZABLE\b/gi,
    message: 'DSQL uses Repeatable Read; do not silently downgrade a Serializable contract.',
  },
  {
    code: 'read-committed-isolation',
    severity: 'blocker',
    pattern: /\bISOLATION\s+LEVEL\s+READ\s+COMMITTED\b/gi,
    message: 'DSQL uses Repeatable Read; this explicit Read Committed contract needs review.',
  },
  {
    code: 'create-database',
    severity: 'blocker',
    pattern: /\bCREATE\s+DATABASE\b/gi,
    message: 'DSQL has one built-in postgres database; Core/PII isolation needs a separate design.',
  },
  {
    code: 'synchronous-index',
    severity: 'manual-review',
    pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+ASYNC\b)/gi,
    message: 'Use a dedicated asynchronous-index plan and verify completion before activation.',
  },
  {
    code: 'function-definition',
    severity: 'manual-review',
    pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi,
    message: 'Check the supported SQL-function subset; procedural languages are not equivalent.',
  },
];

/**
 * Findings are conservative source triage, never an executable migration plan. Even an
 * empty report cannot prove schema equivalence, runtime safety, IAM access, or capacity.
 */
export function assessDsqlCompatibility(
  sources: readonly DsqlCompatibilitySource[]
): DsqlCompatibilityReport {
  const findings: DsqlCompatibilityFinding[] = [];
  for (const source of sources) {
    const add = (
      offset: number,
      code: string,
      severity: DsqlCompatibilityFinding['severity'],
      message: string
    ) => {
      findings.push({
        path: source.path,
        line: source.sql.slice(0, offset).split('\n').length,
        code,
        severity,
        message,
      });
    };
    const segments =
      source.kind === 'typescript'
        ? typescriptLiterals(source.sql)
        : [{ text: source.sql, offset: 0 }];
    const ddl: number[] = [];
    let hasDml = false;
    for (const segment of segments) {
      const code = sqlCode(segment.text);
      for (const rule of RULES) {
        for (const match of code.matchAll(new RegExp(rule.pattern))) {
          add(segment.offset + match.index, rule.code, rule.severity, rule.message);
        }
      }
      for (const match of code.matchAll(
        /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|SCHEMA|ROLE|DATABASE)\b/gi
      )) {
        ddl.push(segment.offset + match.index);
      }
      hasDml ||= /\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM)\b/i.test(code);
    }
    if (ddl.length > 1) {
      add(
        ddl[0],
        'multiple-ddl-statements',
        'manual-review',
        'Multiple DDL statements require separate transactions and durable resume evidence.'
      );
    }
    if (ddl.length > 0 && hasDml) {
      add(
        ddl[0],
        'ddl-and-dml',
        'manual-review',
        'Do not combine DDL and DML in one DSQL transaction; inspect the execution boundaries.'
      );
    }
    if (source.kind === 'typescript') {
      add(
        0,
        'typescript-query-flow',
        'manual-review',
        'Literal inspection cannot verify computed SQL, call ordering, transaction size or retries.'
      );
    }
  }
  findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.code.localeCompare(b.code)
  );
  return {
    schemaVersion: 1,
    assessment: 'static-triage',
    fullRuntimeReady: false,
    sourcesScanned: sources.length,
    findings,
    limitations: [
      'This lexical inventory is not a SQL or TypeScript parser and may miss dynamic or escaped SQL.',
      'No findings does not establish compatibility, complete source coverage, or runtime readiness.',
      'Foreign keys and FOR UPDATE are not classified as unsupported; their DSQL semantics still require tests.',
      'No SQL is executed or rewritten; source values and SQL excerpts are excluded from diagnostics.',
    ],
    requiredWork: [
      'Preserve legal-hold, webhook and service-group invariants when replacing database triggers.',
      'Replace the PostgreSQL initialization, authorization-code and all-at-once restore paths before full-runtime use.',
      'Verify Repeatable Read and OCC retries, uncertain commit outcomes, one-use consumption and tenant isolation.',
      'Validate DDL resume, asynchronous indexes, transaction limits, IAM/TLS and actual DSQL integration separately.',
    ],
  };
}
