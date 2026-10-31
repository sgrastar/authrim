// PostgreSQL 17's image declares PGDATA and VOLUME at /var/lib/postgresql/data.
// Keep these together: PostgreSQL 18 images use a different data layout.
export const POSTGRES_TEST_IMAGE = 'postgres:17-alpine';
export const POSTGRES_TEST_DATA_DIRECTORY = '/var/lib/postgresql/data';

export function postgresTestContainerStartArgs(
  name: string,
  environment: readonly string[]
): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--tmpfs',
    POSTGRES_TEST_DATA_DIRECTORY,
    ...environment.flatMap((value) => ['--env', value]),
    POSTGRES_TEST_IMAGE,
  ];
}

export function postgresTestContainerStopArgs(name: string): string[] {
  return ['rm', '--force', '--volumes', name];
}
