export function renderSlackText(text: string): string {
  return renderText(text, 'slack');
}

export function renderTelegramText(text: string): string {
  return renderText(text, 'telegram');
}

function renderText(text: string, target: 'slack' | 'telegram'): string {
  if (!text) return text;
  const codePattern = /```[\s\S]*?```|`[^`\n]+`/g;
  let rendered = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    rendered += renderSegment(text.slice(lastIndex, match.index), target);
    rendered += match[0];
    lastIndex = match.index + match[0].length;
  }

  return rendered + renderSegment(text.slice(lastIndex), target);
}

function renderSegment(text: string, target: 'slack' | 'telegram'): string {
  let rendered = text;

  if (target === 'telegram') {
    rendered = rendered.replace(
      /___(?=[^\s_])([^_]+?)(?<=[^\s_])___/g,
      '*_$1_*',
    );
    rendered = rendered.replace(
      /\*\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*\*/g,
      '*_$1_*',
    );
  }

  rendered = rendered.replace(
    /(?<!\*)\*(?=[^\s*_])([^*\n]+?)(?<=[^\s*_])\*(?!\*)/g,
    '_$1_',
  );
  rendered = rendered.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  rendered = rendered.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  if (target === 'slack') {
    rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  } else {
    rendered = rendered.replace(/<u>(.*?)<\/u>/g, '__$1__');
  }

  return rendered.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
}
