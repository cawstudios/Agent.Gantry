import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../platform/group-folder.js';
import { PlanEvent } from './types.js';

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function ensurePlanIpcLayout(groupFolder: string): {
  eventsDir: string;
  responsesDir: string;
} {
  const ipcRoot = resolveGroupIpcPath(groupFolder);
  const eventsDir = path.join(ipcRoot, 'plan-events');
  const responsesDir = path.join(ipcRoot, 'plan-responses');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });
  return { eventsDir, responsesDir };
}

export function writePlanEvent(groupFolder: string, event: PlanEvent): string {
  const { eventsDir } = ensurePlanIpcLayout(groupFolder);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(eventsDir, filename);
  writeJsonAtomic(filePath, event);
  return filePath;
}
