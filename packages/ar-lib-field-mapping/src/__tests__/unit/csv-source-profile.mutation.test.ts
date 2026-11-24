import { describe, expect, it } from 'vitest';
import { shortHash } from '../../core/ids';
import {
  parseCsvSourceProfile,
  type CsvSourceProfileColumn,
  type CsvSourceProfileParserOptions,
  type CsvSourceProfileValueType,
} from '../../source-profiles/csv';

function column(
  header: string,
  values: string[],
  options: CsvSourceProfileParserOptions = {}
): CsvSourceProfileColumn {
  const [first] = parseCsvSourceProfile([header, ...values].join('\n'), {
    headerMode: 'first_row',
    ...options,
  }).columns;
  if (!first) throw new Error('expected one column');
  return first;
}

function classificationOf(header: string, values: string[] = ['x']): unknown {
  return column(header, values).candidates.classification;
}

function typeOf(values: string[], header = 'col'): CsvSourceProfileValueType {
  return column(header, values).valueType;
}

describe('csv profile header name classification', () => {
  it.each([
    'email',
    'EMAIL',
    'e-mail',
    'user_email',
    'user.email',
    'user email',
    'email_address',
    'e-mail-2',
    'mail',
    'work.mail',
    'mail_box',
    'my-mail',
  ])('flags %s as a PII candidate', (header) => {
    expect(classificationOf(header)).toBe('pii');
  });

  it.each(['gmail', 'gemail', 'emailer', 'email2', 'mailbox', 'xmail', 'remail'])(
    'does not flag %s from the e-mail patterns',
    (header) => {
      expect(classificationOf(header)).toBeUndefined();
    }
  );

  it.each([
    'phone',
    'mobile',
    'tel',
    'firstname',
    'first_name',
    'first name',
    'first.name',
    'first-name',
    'lastname',
    'last_name',
    'familyname',
    'family_name',
    'givenname',
    'given_name',
    'displayname',
    'display_name',
    'fullname',
    'full_name',
    'full name',
    'address',
    'street',
    'city',
    'postal',
    'zip',
    'birth',
    'dob',
  ])('flags %s as a PII candidate', (header) => {
    expect(classificationOf(header)).toBe('pii');
  });

  it.each([
    'mynumber',
    'my_number',
    'my number',
    'personalnumber',
    'personal_number',
    'ssn',
    'taxid',
    'tax_id',
    'tax-id',
    'nationalid',
    'national_id',
    'passport',
    'driverlicense',
    'driver_license',
  ])('flags %s as a regulated candidate', (header) => {
    expect(classificationOf(header)).toBe('regulated');
  });

  it('prefers regulated over PII when both patterns match', () => {
    expect(classificationOf('passport_email')).toBe('regulated');
  });

  it.each(['status', 'code', 'department', 'my_x_number'])(
    'leaves %s without a classification candidate',
    (header) => {
      expect(classificationOf(header)).toBeUndefined();
    }
  );
});

describe('csv profile value classification', () => {
  it('flags social-security shaped values as regulated', () => {
    expect(classificationOf('code', ['123-45-6789'])).toBe('regulated');
    expect(classificationOf('code', ['x', '123-45-6789'])).toBe('regulated');
  });

  it.each([
    '123-45-67890',
    'x123-45-6789',
    '1234-45-6789',
    '123-4-6789',
    '123-45-678',
    'abc-45-6789',
    '123-ab-6789',
    '123-45-abcd',
    '123456789',
  ])('does not treat %s as regulated', (value) => {
    expect(classificationOf('code', [value])).toBeUndefined();
  });

  it('flags e-mail shaped values as PII', () => {
    expect(classificationOf('code', ['abc@def.ghi'])).toBe('pii');
    expect(classificationOf('code', ['x', 'abc@def.ghi'])).toBe('pii');
  });

  it.each([
    'a@b',
    '@b.co',
    'a@.co',
    'a@b.',
    '@@b.co',
    'a@@.b',
    'a@b.@@',
    'x a@b.co',
    'a@b.co x',
    'a@b@c.de',
  ])('does not treat %s as an e-mail address', (value) => {
    expect(classificationOf('code', [`"${value}"`])).toBeUndefined();
  });

  it('prefers a regulated value over a PII value', () => {
    expect(classificationOf('code', ['abc@def.ghi', '123-45-6789'])).toBe('regulated');
  });

  it('looks at trimmed values only', () => {
    expect(classificationOf('code', ['  123-45-6789  '])).toBe('regulated');
  });
});

describe('csv profile value type inference', () => {
  it('uses string for columns without any value', () => {
    expect(typeOf([])).toBe('string');
    expect(typeOf(['', '   '])).toBe('string');
    expect(typeOf([''], 'phone')).toBe('string');
  });

  it('infers phone from the header before looking at values', () => {
    expect(typeOf(['abc@def.ghi'], 'phone')).toBe('phone');
    expect(typeOf(['1'], 'mobile')).toBe('phone');
    expect(typeOf(['1'], 'tel')).toBe('phone');
    expect(typeOf(['x'], 'PHONE')).toBe('phone');
  });

  it('infers email only when every value looks like an address', () => {
    expect(typeOf(['abc@def.ghi', 'jkl@mno.pqr'])).toBe('email');
    expect(typeOf(['abc@def.ghi', 'x'])).toBe('string');
    expect(typeOf(['a@b', 'abc@def.ghi'])).toBe('string');
    expect(typeOf(['@@b.co'])).toBe('string');
    expect(typeOf(['"x a@b.co"'])).toBe('string');
    expect(typeOf(['"a@b.co x"'])).toBe('string');
  });

  it('infers boolean only when every value is a boolean word or digit', () => {
    expect(typeOf(['true', 'False', 'YES', 'no', '0', '1'])).toBe('boolean');
    expect(typeOf(['true', 'maybe'])).toBe('string');
    expect(typeOf(['xtrue'])).toBe('string');
    expect(typeOf(['true1'])).toBe('string');
    expect(typeOf(['0', '2'])).toBe('number');
  });

  it('infers json for object and array text only', () => {
    const quoted = (values: string[]) => values.map((value) => `"${value.replaceAll('"', '""')}"`);
    expect(typeOf(quoted(['{"a":1}', '[1,2]', '  {"b":2}  ']))).toBe('json');
    expect(typeOf(quoted(['{"a":1}', 'x']))).toBe('string');
    expect(typeOf(quoted(['{bad}']))).toBe('string');
    expect(typeOf(quoted(['x{"a":1}']))).toBe('string');
    expect(typeOf(quoted(['"text"']))).toBe('string');
    expect(typeOf(quoted(['null']))).toBe('string');
    expect(typeOf(quoted(['[1,2']))).toBe('string');
    expect(typeOf(quoted(['"[1]"']))).toBe('string');
  });

  it('infers number for plain decimal text only', () => {
    expect(typeOf(['-1', '2.5', '10', '-0.5', '2.55'])).toBe('number');
    expect(typeOf(['1', 'x'])).toBe('string');
    expect(typeOf(['2', '3', 'x'])).toBe('string');
    for (const value of ['1.', '.5', '1e5', '--1', '1.2.3', '+1', 'x5', '5x', '1,5']) {
      expect(typeOf([`"${value}"`])).toBe('string');
    }
  });

  it('infers date for ISO calendar dates only', () => {
    expect(typeOf(['2024-01-31', '1999-12-01'])).toBe('date');
    expect(typeOf(['2024-01-31', 'x'])).toBe('string');
    for (const value of [
      '2024-1-31',
      '24-01-31',
      'abcd-01-31',
      '2024-ab-31',
      '2024-01-ab',
      'x2024-01-31',
    ]) {
      expect(typeOf([value])).toBe('string');
    }
  });

  it('infers datetime for parseable values that carry a time marker', () => {
    expect(typeOf(['2024-01-31T10:00:00Z'])).toBe('datetime');
    expect(typeOf(['2024-01-31 10:00', '2024-02-01 11:30'])).toBe('datetime');
    expect(typeOf(['2024-01-31T10:00:00Z', 'x'])).toBe('string');
    expect(typeOf(['Jan 5 2024'])).toBe('string');
    expect(typeOf(['tomorrow'])).toBe('string');
    expect(typeOf(['2024-01-31x'])).toBe('string');
  });

  it('only suggests a value type for non-string columns', () => {
    expect(column('col', ['text']).candidates.valueType).toBeUndefined();
    expect(column('col', ['1']).candidates.valueType).toBe('boolean');
    expect(column('col', ['text']).warnings).not.toContain('type_candidate');
    expect(column('col', ['5']).warnings).toContain('type_candidate');
  });
});

describe('csv profile column statistics', () => {
  it('computes empty rates from trimmed values', () => {
    const profiled = column('col', ['a', '', '  ', 'b']);
    expect(profiled.emptyRate).toBe(0.5);
    expect(profiled.observedNonEmptyRows).toBe(2);
    expect(profiled.candidates.required).toBeUndefined();
    expect(profiled.warnings).not.toContain('required_candidate');
  });

  it('marks columns without any empty sampled value as required candidates', () => {
    const profiled = column('col', ['a', 'b', 'c']);
    expect(profiled.emptyRate).toBe(0);
    expect(profiled.observedNonEmptyRows).toBe(3);
    expect(profiled.candidates.required).toBe(true);
    expect(profiled.warnings).toContain('required_candidate');
    expect(profiled.required).toBe(false);
    expect(profiled.classification).toBe('internal');
  });

  it('never calls a column without sampled rows a required candidate', () => {
    const profile = parseCsvSourceProfile('a,b', { headerMode: 'first_row' });
    expect(profile.columns.map((item) => item.emptyRate)).toEqual([0, 0]);
    expect(profile.columns.map((item) => item.candidates.required)).toEqual([undefined, undefined]);
    expect(profile.summary.requiredCandidateCount).toBe(0);
    expect(profile.warnings).toEqual([]);
  });

  it('reports the required candidate warning with its message', () => {
    const profile = parseCsvSourceProfile('name\nalice', { headerMode: 'first_row' });
    const [item] = profile.columns;
    expect(profile.warnings).toEqual([
      {
        code: 'required_candidate',
        severity: 'info',
        columnId: item?.stableColumnId,
        message: 'name has no empty sampled values and is a required candidate.',
      },
    ]);
  });

  it('treats a missing cell like an empty one', () => {
    const profile = parseCsvSourceProfile('a,b\n1', { headerMode: 'first_row' });
    expect(profile.columns[1]).toMatchObject({
      emptyRate: 1,
      observedNonEmptyRows: 0,
      valueType: 'string',
    });
    expect(profile.columns[1]?.candidates.required).toBeUndefined();
  });
});

describe('csv profile warnings', () => {
  it('warns about PII and regulated candidates with exact messages', () => {
    const profile = parseCsvSourceProfile('email,ssn,other\nx,y,', { headerMode: 'first_row' });
    const [email, ssn, other] = profile.columns;
    expect(profile.warnings).toEqual([
      {
        code: 'pii_candidate',
        severity: 'warning',
        columnId: email?.stableColumnId,
        message: 'email looks like PII and must be confirmed before activation.',
      },
      {
        code: 'required_candidate',
        severity: 'info',
        columnId: email?.stableColumnId,
        message: 'email has no empty sampled values and is a required candidate.',
      },
      {
        code: 'regulated_candidate',
        severity: 'warning',
        columnId: ssn?.stableColumnId,
        message: 'ssn looks regulated and must be confirmed before activation.',
      },
      {
        code: 'required_candidate',
        severity: 'info',
        columnId: ssn?.stableColumnId,
        message: 'ssn has no empty sampled values and is a required candidate.',
      },
    ]);
    expect(email?.warnings).toEqual(['pii_candidate', 'required_candidate']);
    expect(ssn?.warnings).toEqual(['regulated_candidate', 'required_candidate']);
    expect(other?.warnings).toEqual([]);
  });

  it('counts candidates in the summary', () => {
    const profile = parseCsvSourceProfile('email,ssn,plain,other\na,b,,\nd,e,,\ng,h,x,', {
      headerMode: 'first_row',
    });
    expect(profile.summary).toEqual({
      columnCount: 4,
      rowSampleCount: 3,
      piiCandidateCount: 1,
      regulatedCandidateCount: 1,
      requiredCandidateCount: 2,
      blockingWarningCount: 2,
    });
  });

  it('warns about empty and duplicate headers', () => {
    const profile = parseCsvSourceProfile('Name, ,name,NAME,x\n1,2,3,4,5', {
      headerMode: 'first_row',
    });
    const ids = profile.columns.map((item) => item.stableColumnId);
    expect(profile.columns.map((item) => item.headerName)).toEqual([
      'Name',
      'column_2',
      'name',
      'NAME',
      'x',
    ]);
    const structural = profile.warnings.filter(
      (warning) => warning.code === 'empty_header' || warning.code === 'duplicate_header'
    );
    expect(structural).toEqual([
      {
        code: 'empty_header',
        severity: 'warning',
        columnId: ids[1],
        message: 'column_2 has an empty header name.',
      },
      {
        code: 'duplicate_header',
        severity: 'warning',
        columnId: ids[2],
        message: 'name appears more than once.',
      },
      {
        code: 'duplicate_header',
        severity: 'warning',
        columnId: ids[3],
        message: 'NAME appears more than once.',
      },
    ]);
    expect(profile.columns[0]?.warnings).not.toContain('duplicate_header');
    expect(profile.columns[1]?.warnings).toContain('empty_header');
    expect(profile.columns[2]?.warnings).toContain('duplicate_header');
  });

  it('does not report empty headers when the file has no header row', () => {
    const profile = parseCsvSourceProfile('a,b\n1,2', { headerMode: 'none' });
    expect(profile.columns.map((item) => item.headerName)).toEqual(['column_1', 'column_2']);
    expect(profile.warnings.filter((warning) => warning.code === 'empty_header')).toEqual([]);
    expect(profile.parser.sampledRows).toBe(2);
    expect(profile.summary.rowSampleCount).toBe(2);
  });

  it('names columns that only the data rows reach', () => {
    const profile = parseCsvSourceProfile('a,b\nx,y,z', { headerMode: 'first_row' });
    expect(profile.columns.map((item) => item.headerName)).toEqual(['a', 'b', 'column_3']);
    expect(profile.columns[2]?.warnings).toContain('empty_header');
    expect(profile.columns[2]?.observedNonEmptyRows).toBe(1);
  });

  it('trims header names', () => {
    const profile = parseCsvSourceProfile('  Name  \nx', { headerMode: 'first_row' });
    expect(profile.columns[0]?.headerName).toBe('Name');
  });

  it('limits sampled columns and says so', () => {
    const profile = parseCsvSourceProfile('a,b,c\n1,2', { headerMode: 'first_row', maxColumns: 2 });
    expect(profile.parser).toMatchObject({ sampledColumns: 2, truncatedColumns: true });
    expect(profile.columns.map((item) => item.headerName)).toEqual(['a', 'b']);
    expect(profile.warnings).toContainEqual({
      code: 'column_limit_reached',
      severity: 'warning',
      message: 'Only the first 2 columns were sampled.',
    });
  });

  it('flags column truncation when only a later row is wide', () => {
    const profile = parseCsvSourceProfile('a,b\n1,2,3\n4,5', {
      headerMode: 'first_row',
      maxColumns: 2,
    });
    expect(profile.parser.truncatedColumns).toBe(true);
    const narrow = parseCsvSourceProfile('a,b,c\n1,2', { headerMode: 'first_row', maxColumns: 2 });
    expect(narrow.parser.truncatedColumns).toBe(true);
  });

  it('does not flag column truncation at exactly the column limit', () => {
    const profile = parseCsvSourceProfile('a,b\n1,2', { headerMode: 'first_row', maxColumns: 2 });
    expect(profile.parser.truncatedColumns).toBe(false);
    expect(profile.warnings.filter((warning) => warning.code === 'column_limit_reached')).toEqual(
      []
    );
  });

  it('limits sampled rows and says so', () => {
    const profile = parseCsvSourceProfile('h\n1\n2\n3\n4', { headerMode: 'first_row', maxRows: 2 });
    expect(profile.parser).toMatchObject({ sampledRows: 2, truncatedRows: true });
    expect(profile.warnings).toContainEqual({
      code: 'row_sample_limit_reached',
      severity: 'info',
      message: 'Only the first 2 data rows were sampled.',
    });
  });

  it('does not flag row truncation when the sample fits', () => {
    const profile = parseCsvSourceProfile('h\n1\n2', { headerMode: 'first_row', maxRows: 2 });
    expect(profile.parser).toMatchObject({ sampledRows: 2, truncatedRows: false });
    expect(
      profile.warnings.filter((warning) => warning.code === 'row_sample_limit_reached')
    ).toEqual([]);
  });
});

describe('csv profile input bounds', () => {
  const header = 'a\n';

  it('accepts input of exactly one million characters', () => {
    const input = header + 'x'.repeat(1_000_000 - header.length);
    expect(input).toHaveLength(1_000_000);
    const profile = parseCsvSourceProfile(input, { headerMode: 'first_row' });
    expect(profile.parser.truncatedRows).toBe(false);
    expect(
      profile.warnings.filter((warning) => warning.code === 'row_sample_limit_reached')
    ).toEqual([]);
  });

  it('ignores everything after the first million characters', () => {
    const input = header + 'x'.repeat(1_000_000 - header.length) + '\nsecond';
    const profile = parseCsvSourceProfile(input, { headerMode: 'first_row' });
    expect(profile.parser.truncatedRows).toBe(true);
    expect(profile.parser.sampledRows).toBe(1);
    expect(profile.warnings).toContainEqual({
      code: 'row_sample_limit_reached',
      severity: 'info',
      message: 'Only the first 500 data rows were sampled.',
    });
  });

  it('flags a single character over the limit', () => {
    const input = header + 'x'.repeat(1_000_000 - header.length + 1);
    const profile = parseCsvSourceProfile(input, { headerMode: 'first_row' });
    expect(profile.parser.truncatedRows).toBe(true);
    expect(profile.parser.sampledRows).toBe(1);
  });
});

describe('csv profile parser options', () => {
  it('honours an explicit delimiter over auto detection', () => {
    const profile = parseCsvSourceProfile('a;b,c,d\n1;2,3,4', { delimiter: ';' });
    expect(profile.parser.delimiter).toBe(';');
    expect(profile.columns.map((item) => item.headerName)).toEqual(['a', 'b,c,d']);
  });

  it('honours an explicit newline over auto detection', () => {
    expect(parseCsvSourceProfile('a,b\r\n1,2', { newline: '\n' }).parser.newline).toBe('\n');
    expect(parseCsvSourceProfile('a,b\n1,2', { newline: '\r\n' }).parser.newline).toBe('\r\n');
  });

  it('detects the newline style', () => {
    expect(parseCsvSourceProfile('a,b\r\n1,2').parser.newline).toBe('\r\n');
    expect(parseCsvSourceProfile('a,b\n1,2').parser.newline).toBe('\n');
    expect(parseCsvSourceProfile('a,b\r1,2').parser.newline).toBe('\n');
  });

  it.each([
    ['a,b\n1,2', ','],
    ['a;b\n1;2', ';'],
    ['a\tb\n1\t2', '\t'],
    ['a|b\n1|2', '|'],
    ['a,b;c\n1', ','],
    ['a|b|c,d\n1', '|'],
    ['a\tb\tc;d,e\n1', '\t'],
    ['abc', ','],
    ['a;b\r\n1;2', ';'],
  ])('detects the delimiter of %j as %j', (input, expected) => {
    expect(parseCsvSourceProfile(input).parser.delimiter).toBe(expected);
  });

  it('only looks at the first ten lines when detecting the delimiter', () => {
    const lines = Array.from({ length: 10 }, () => 'a;b');
    const rest = Array.from({ length: 5 }, () => 'a,b,c,d,e,f,g,h');
    expect(parseCsvSourceProfile([...lines, ...rest].join('\n')).parser.delimiter).toBe(';');
    expect(parseCsvSourceProfile([...lines, ...rest].join('\r\n')).parser.delimiter).toBe(';');
  });

  it('defaults the quote and escape characters', () => {
    const profile = parseCsvSourceProfile('a\n"x"');
    expect(profile.parser).toMatchObject({ quote: '"', escape: '"' });
    expect(parseCsvSourceProfile("a\n'x'", { quote: "'" }).parser).toMatchObject({
      quote: "'",
      escape: "'",
    });
    expect(parseCsvSourceProfile('a\nx', { quote: "'", escape: '\\' }).parser).toMatchObject({
      quote: "'",
      escape: '\\',
    });
  });

  it('parses quoted cells with delimiters, newlines and escaped quotes', () => {
    const profile = parseCsvSourceProfile('a,b\n"x,1","y\nz"\n"q""r",s', {
      headerMode: 'first_row',
    });
    expect(profile.parser.sampledRows).toBe(2);
    expect(profile.columns.map((item) => item.observedNonEmptyRows)).toEqual([2, 2]);
  });

  it('honours a backslash escape character', () => {
    const profile = parseCsvSourceProfile('a\n"x\\"y"\nz', {
      headerMode: 'first_row',
      escape: '\\',
    });
    expect(profile.parser.sampledRows).toBe(2);
  });

  it('honours a custom quote character', () => {
    const profile = parseCsvSourceProfile("a,b\n'x,y',z", { headerMode: 'first_row', quote: "'" });
    expect(profile.columns).toHaveLength(2);
    expect(profile.columns[0]?.observedNonEmptyRows).toBe(1);
  });

  it('keeps the first character after a lone carriage return', () => {
    const profile = parseCsvSourceProfile('h\rx\ry', { headerMode: 'first_row' });
    expect(profile.parser.sampledRows).toBe(2);
    expect(profile.columns[0]).toMatchObject({ observedNonEmptyRows: 2, emptyRate: 0 });
  });

  it('treats CRLF, LF and CR as one row break each', () => {
    for (const input of ['a,b\r\n1,2\r\n3,4', 'a,b\n1,2\n3,4', 'a,b\r1,2\r3,4']) {
      const profile = parseCsvSourceProfile(input, { headerMode: 'first_row', delimiter: ',' });
      expect(profile.parser.sampledRows).toBe(2);
      expect(profile.summary.columnCount).toBe(2);
    }
  });

  it('keeps a trailing empty cell and ignores a trailing line break', () => {
    const trailingCell = parseCsvSourceProfile('a,b\n1,', { headerMode: 'first_row' });
    expect(trailingCell.columns[1]).toMatchObject({ emptyRate: 1, observedNonEmptyRows: 0 });
    expect(trailingCell.parser.sampledRows).toBe(1);
    const trailingBreak = parseCsvSourceProfile('a,b\n1,2\n', { headerMode: 'first_row' });
    expect(trailingBreak.parser.sampledRows).toBe(1);
  });

  it('samples at most maxRows data rows without a trailing break', () => {
    expect(
      parseCsvSourceProfile('h\n1\n2', { headerMode: 'first_row', maxRows: 2 }).parser
    ).toMatchObject({ sampledRows: 2, truncatedRows: false });
    expect(
      parseCsvSourceProfile('h\n1\n2\n3', { headerMode: 'first_row', maxRows: 2 }).parser
    ).toMatchObject({ sampledRows: 2, truncatedRows: true });
  });

  it('normalizes row and column limits', () => {
    const wide = 'a,b,c\n1,2,3';
    expect(parseCsvSourceProfile(wide, { maxColumns: 0 }).parser.sampledColumns).toBe(1);
    expect(parseCsvSourceProfile(wide, { maxColumns: -5 }).parser.sampledColumns).toBe(1);
    expect(parseCsvSourceProfile(wide, { maxColumns: 2.9 }).parser.sampledColumns).toBe(2);
    expect(parseCsvSourceProfile(wide, { maxColumns: Number.NaN }).parser.sampledColumns).toBe(3);
    expect(parseCsvSourceProfile(wide, { maxColumns: 1000 }).parser.sampledColumns).toBe(3);
    expect(parseCsvSourceProfile(wide, { maxColumns: Infinity }).parser.sampledColumns).toBe(3);
    const rows = 'h\n1\n2\n3';
    expect(
      parseCsvSourceProfile(rows, { headerMode: 'first_row', maxRows: 0 }).parser.sampledRows
    ).toBe(1);
    expect(
      parseCsvSourceProfile(rows, { headerMode: 'first_row', maxRows: 2.9 }).parser.sampledRows
    ).toBe(2);
  });

  it('caps the limits at their defaults', () => {
    const manyColumns = Array.from({ length: 201 }, (_, index) => `c${index}`).join(',');
    const columns = parseCsvSourceProfile(manyColumns, { maxColumns: 10_000 });
    expect(columns.parser).toMatchObject({ sampledColumns: 200, truncatedColumns: true });
    const manyRows = ['h', ...Array.from({ length: 600 }, (_, index) => String(index))].join('\n');
    const rows = parseCsvSourceProfile(manyRows, { headerMode: 'first_row', maxRows: 10_000 });
    expect(rows.parser).toMatchObject({ sampledRows: 500, truncatedRows: true });
  });

  it('handles empty input', () => {
    const profile = parseCsvSourceProfile('');
    expect(profile.columns).toEqual([]);
    expect(profile.parser).toMatchObject({
      headerMode: 'none',
      sampledRows: 0,
      sampledColumns: 0,
      truncatedRows: false,
      truncatedColumns: false,
    });
    expect(profile.summary).toEqual({
      columnCount: 0,
      rowSampleCount: 0,
      piiCandidateCount: 0,
      regulatedCandidateCount: 0,
      requiredCandidateCount: 0,
      blockingWarningCount: 0,
    });
  });
});

describe('csv profile header mode detection', () => {
  const mode = (input: string, headerMode?: CsvSourceProfileParserOptions['headerMode']) =>
    parseCsvSourceProfile(input, { headerMode }).parser.headerMode;

  it('honours an explicit header mode', () => {
    expect(mode('1,2\n3,4', 'first_row')).toBe('first_row');
    expect(mode('a,b\nc,d', 'none')).toBe('none');
  });

  it('detects a textual first row as a header', () => {
    expect(mode('name,age\nx,1')).toBe('first_row');
    expect(mode('1,abc\n2,3')).toBe('first_row');
    expect(mode('1,_\n2,3')).toBe('first_row');
    expect(mode('a')).toBe('first_row');
  });

  it('detects a numeric first row followed by e-mail data as a header', () => {
    expect(mode('1,2\n3,abc@def.ghi')).toBe('first_row');
    expect(mode('1,2\nabc@def.ghi,4')).toBe('first_row');
  });

  it('does not detect a header in numeric rows', () => {
    expect(mode('1,2\n3,4')).toBe('none');
    expect(mode('1,2')).toBe('none');
    expect(mode('')).toBe('none');
  });

  it.each(['a@b', '@b.co', 'a@.co', '@@b.co', 'a@@.b', 'a@b.@@', '"x a@b.co"', '"a@b.co x"'])(
    'does not take %s in the second row for e-mail data',
    (cell) => {
      expect(mode(`1,2\n3,${cell}`)).toBe('none');
    }
  );

  it('checks the second row only for e-mail data', () => {
    expect(mode('1,2\n3,4\nabc@def.ghi,5')).toBe('none');
  });
});

describe('csv profile column identity and labels', () => {
  it('derives a stable id from the normalized header and a hash of header and index', () => {
    const profile = parseCsvSourceProfile('First Name,-x-,a   b\n1,2,3', {
      headerMode: 'first_row',
    });
    expect(profile.columns.map((item) => item.stableColumnId)).toEqual([
      `csv.first-name.${shortHash(['First Name', 0])}`,
      `csv.x.${shortHash(['-x-', 1])}`,
      `csv.a-b.${shortHash(['a   b', 2])}`,
    ]);
  });

  it('falls back to a positional id part when the header has no usable characters', () => {
    const profile = parseCsvSourceProfile('---,日本\n1,2', { headerMode: 'first_row' });
    expect(profile.columns.map((item) => item.stableColumnId)).toEqual([
      `csv.column-1.${shortHash(['---', 0])}`,
      `csv.column-2.${shortHash(['日本', 1])}`,
    ]);
  });

  it('keeps ids distinct for headers that only differ by position', () => {
    const profile = parseCsvSourceProfile('a,a\n1,2', { headerMode: 'first_row' });
    const [first, second] = profile.columns.map((item) => item.stableColumnId);
    expect(first).not.toBe(second);
  });

  it.each([
    ['first_name', 'First Name'],
    ['first-name', 'First Name'],
    ['a.b-c_d', 'A B C D'],
    ['first   name', 'First Name'],
    ['fooBar', 'FooBar'],
    ['_name_', 'Name'],
    ['a__b', 'A B'],
    ['name', 'Name'],
    ['___', '___'],
    ['.-', '.-'],
  ])('labels header %j as %j', (header, label) => {
    expect(column(header, ['x']).label).toBe(label);
  });
});
