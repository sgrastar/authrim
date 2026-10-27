import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchReplication } from './scheduler';

export async function runReplicationSchedulerCli(args: readonly string[]): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const [command, ...rest] = args;
    const keys = ['config', 'config-sha256', 'state-dir', 'interval-seconds'];
    const values: Record<string, string> = {};
    if (command !== 'watch' || rest.length !== 8) throw new Error();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index].slice(2);
      if (
        !rest[index].startsWith('--') ||
        !keys.includes(key) ||
        values[key] !== undefined ||
        !rest[index + 1]
      )
        throw new Error();
      values[key] = rest[index + 1];
    }
    if (!/^[1-9][0-9]*$/u.test(values['interval-seconds'])) throw new Error();
    await watchReplication(
      {
        configPath: values.config,
        configSha256: values['config-sha256'],
        stateDirectory: values['state-dir'],
        intervalSeconds: Number(values['interval-seconds']),
        executorPath: fileURLToPath(new URL('./replication-cli.mjs', import.meta.url)),
        schedulerPath: fileURLToPath(import.meta.url),
      },
      controller.signal
    );
    process.stdout.write('{"status":"stopped","automaticPromotion":false}\n');
  } catch {
    process.stderr.write(
      'replication_watch_stopped; inspect saved state and reviewed configuration before restarting\n'
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await runReplicationSchedulerCli(process.argv.slice(2));
