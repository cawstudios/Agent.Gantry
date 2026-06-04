import fs from 'node:fs';
import path from 'node:path';

// Walks up from the start dir looking for a .env and applies it without
// overwriting already-set process.env keys. Copied from mcp-shopify so this
// package stays self-contained (no cross-package import). Lets boondi-crm pick
// up the shared GANTRY_HOME/.env (identity secret, DB url) the same way.
const SEARCH_FILE = '.env';
const MAX_HOPS = 6;

export function loadDotenvUpwards(
  startDir: string = process.cwd(),
): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < MAX_HOPS; i += 1) {
    const candidate = path.join(dir, SEARCH_FILE);
    if (fs.existsSync(candidate)) {
      applyEnvFile(candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function applyEnvFile(filePath: string): void {
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
