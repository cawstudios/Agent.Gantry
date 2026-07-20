import { spawn } from 'node:child_process';

export function spawnTransparentStdioChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
