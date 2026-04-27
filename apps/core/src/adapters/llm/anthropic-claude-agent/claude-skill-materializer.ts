import fs from 'fs';
import path from 'path';

export interface ClaudeSkillSourceItem {
  id: string;
  name: string;
  sourceDir: string;
  enabled: boolean;
}

export interface SkillSource {
  listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]>;
}

export class BundledClaudeSkillSource implements SkillSource {
  constructor(private readonly packageRoot: string) {}

  async listSkills(input?: {
    enabledSkillIds?: string[];
  }): Promise<ClaudeSkillSourceItem[]> {
    const skillsRoot = path.join(this.packageRoot, '.claude', 'skills');
    if (!fs.existsSync(skillsRoot)) return [];
    const enabled = input?.enabledSkillIds
      ? new Set(input.enabledSkillIds)
      : undefined;

    return fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const sourceDir = path.join(skillsRoot, entry.name);
        return {
          id: entry.name,
          name: entry.name,
          sourceDir,
          enabled: !enabled || enabled.has(entry.name),
        };
      });
  }
}

export async function materializeClaudeSkills(input: {
  skillSource: SkillSource;
  skillsDir: string;
  enabledSkillIds?: string[];
}): Promise<ClaudeSkillSourceItem[]> {
  const skills = await input.skillSource.listSkills({
    enabledSkillIds: input.enabledSkillIds,
  });
  fs.mkdirSync(input.skillsDir, { recursive: true, mode: 0o700 });

  const materialized: ClaudeSkillSourceItem[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const sourceDir = path.resolve(skill.sourceDir);
    const skillFile = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const targetDir = path.join(input.skillsDir, sanitizeSkillName(skill.name));
    copyDirRecursive(sourceDir, targetDir);
    materialized.push(skill);
  }
  return materialized;
}

function sanitizeSkillName(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return safe || 'skill';
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
