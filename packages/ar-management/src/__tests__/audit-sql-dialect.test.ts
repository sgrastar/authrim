import { describe, expect, it } from 'vitest';
import { getAuditJsonTextExpr, getAuditTimelineGrouping } from '../audit-sql-dialect';

describe('audit-sql-dialect', () => {
  it('renders dialect-specific audit JSON extraction expressions', () => {
    expect(getAuditJsonTextExpr('details_json', 'client_id', 'sqlite')).toBe(
      "json_extract(details_json, '$.client_id')"
    );
    expect(getAuditJsonTextExpr('details_json', 'client_id', 'postgres')).toBe(
      "(COALESCE(details_json, '{}')::jsonb ->> 'client_id')"
    );
    expect(getAuditJsonTextExpr('details_json', 'client_id', 'mysql')).toBe(
      "JSON_UNQUOTE(JSON_EXTRACT(COALESCE(details_json, '{}'), '$.client_id'))"
    );
  });

  it('renders timeline grouping expressions from one dedicated helper', () => {
    expect(getAuditTimelineGrouping('hour', 'sqlite', 'milliseconds')).toContain(
      "strftime('%Y-%m-%d %H:00:00'"
    );
    expect(getAuditTimelineGrouping('week', 'mysql', 'milliseconds')).toContain(
      "DATE_FORMAT(FROM_UNIXTIME((created_at / 1000.0)), '%x-%v')"
    );
    expect(getAuditTimelineGrouping('day', 'postgres', 'seconds')).toContain(
      "to_char(date_trunc('day', to_timestamp(created_at)), 'YYYY-MM-DD')"
    );
  });
});
