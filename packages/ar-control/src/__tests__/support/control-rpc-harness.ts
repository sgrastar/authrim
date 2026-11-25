import { vi, type Mock } from 'vitest';
import ControlWorker from '../../index';
import type { ControlEnv, ControlRpcProps } from '../../types';
import { must } from './control-rpc-recorder';

export * from './control-rpc-recorder';

export function make(
  props: Partial<ControlRpcProps> = {},
  overrides: Partial<ControlEnv> = {}
): {
  control: ControlWorker;
  env: ControlEnv;
  waitUntil: Mock;
} {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'env-1',
    CONTROL_DB: { marker: 'control-db' } as unknown as D1Database,
    ...overrides,
  } as ControlEnv;
  const waitUntil = vi.fn();
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'env-1',
        ...props,
      },
      waitUntil,
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env, waitUntil };
}

export function invoke(control: ControlWorker, method: string, input?: unknown): Promise<unknown> {
  const target = control as unknown as Record<string, (value?: unknown) => Promise<unknown>>;
  const handler = must(target[method], method);
  return handler.call(control, input);
}
