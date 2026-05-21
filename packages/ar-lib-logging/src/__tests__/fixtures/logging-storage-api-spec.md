# Logging / Storage Admin API Specification Fixture

This public fixture mirrors the enum registry block from the private canonical
logging/storage API specification so CI can validate registry drift without
depending on private repository files.

```ts
export type LogType =
  | 'normal'
  | 'audit'
  | 'admin_audit'
  | 'security'
  | 'pii'
  | 'diagnostic'
  | 'job'
  | 'webhook'
  | 'operational';

export type LogPlane =
  | 'primary'
  | 'archive'
  | 'external_sink'
  | 'sensitive_detail'
  | 'diagnostic_detail'
  | 'delivery_event';
```
