import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from './logging.js';

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

export async function runScript(
  script: string,
  env: Record<string, string | undefined>,
): Promise<ScriptResult | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-script-'));
  const scriptPath = path.join(tempDir, 'task-script.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }

        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}
