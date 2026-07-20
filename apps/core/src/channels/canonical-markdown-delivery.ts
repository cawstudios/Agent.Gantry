const CANONICAL_MARKDOWN_TOKEN_PATTERN =
  /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\((?:\\.|[^\\\n)])+\)|\*\*\*(?=\S)[^*]+?(?<=\S)\*\*\*|___(?=\S)[^_]+?(?<=\S)___|\*\*(?=\S)[^*]+?(?<=\S)\*\*|__(?=\S)[^_]+?(?<=\S)__|(?<!\*)\*(?=\S)[^*\n]+?(?<=\S)\*(?!\*)|(?<!_)_(?=\S)[^_\n]+?(?<=\S)_(?!_)|~(?=\S)[^~\n]+?(?<=\S)~|\|\|(?=\S)[^|\n]+?(?<=\S)\|\||<u>[\s\S]*?<\/u>|^#{1,6}\s+.+$|^(-{3,}|\*{3,}|_{3,})$/gm;

export interface CanonicalMarkdownDeliveryChunk {
  canonicalText: string;
  renderedText: string;
}

export function planCanonicalMarkdownDeliveryChunks(input: {
  canonicalText: string;
  maxRenderedCodeUnits: number;
  render: (canonicalText: string) => string;
}): CanonicalMarkdownDeliveryChunk[] {
  if (!input.canonicalText) return [];
  if (input.maxRenderedCodeUnits <= 0) {
    return [deliveryChunk(input.canonicalText, input.render)];
  }
  const planned = tokenizeCanonicalMarkdown(input.canonicalText).flatMap(
    (token) => planCanonicalToken(token, input),
  );
  const chunks: CanonicalMarkdownDeliveryChunk[] = [];
  let current: CanonicalMarkdownDeliveryChunk | undefined;
  for (const part of planned) {
    if (!part.renderedText) continue;
    if (
      current &&
      current.renderedText.length + part.renderedText.length <=
        input.maxRenderedCodeUnits
    ) {
      current = {
        canonicalText: current.canonicalText + part.canonicalText,
        renderedText: current.renderedText + part.renderedText,
      };
      chunks[chunks.length - 1] = current;
      continue;
    }
    current = part;
    chunks.push(part);
  }
  return chunks;
}

export function canonicalTailAfterRenderedPrefix(input: {
  canonicalText: string;
  renderedPrefix: string;
  render: (canonicalText: string) => string;
}): string {
  if (!input.renderedPrefix) return input.canonicalText;
  const rendered = input.render(input.canonicalText);
  if (rendered === input.renderedPrefix) return '';
  if (!rendered.startsWith(input.renderedPrefix)) return input.canonicalText;

  const segments = tokenizeCanonicalMarkdown(input.canonicalText).map(
    (canonicalText) => ({
      canonicalText,
      renderedText: input.render(canonicalText),
    }),
  );
  if (segments.map((segment) => segment.renderedText).join('') !== rendered) {
    return input.canonicalText;
  }

  let canonicalOffset = 0;
  let renderedOffset = 0;
  for (const segment of segments) {
    if (renderedOffset === input.renderedPrefix.length) {
      return input.canonicalText.slice(canonicalOffset);
    }
    if (
      segment.renderedText === segment.canonicalText &&
      input.renderedPrefix.length < renderedOffset + segment.renderedText.length
    ) {
      return input.canonicalText.slice(
        canonicalOffset + input.renderedPrefix.length - renderedOffset,
      );
    }
    if (
      input.renderedPrefix.length <
      renderedOffset + segment.renderedText.length
    ) {
      return input.canonicalText.slice(canonicalOffset);
    }
    canonicalOffset += segment.canonicalText.length;
    renderedOffset += segment.renderedText.length;
  }
  return input.canonicalText;
}

function tokenizeCanonicalMarkdown(text: string): string[] {
  const tokens: string[] = [];
  const pattern = new RegExp(CANONICAL_MARKDOWN_TOKEN_PATTERN.source, 'gm');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex)
      tokens.push(text.slice(lastIndex, match.index));
    tokens.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens.length > 0 ? tokens : [text];
}

function planCanonicalToken(
  canonicalText: string,
  input: {
    maxRenderedCodeUnits: number;
    render: (canonicalText: string) => string;
  },
): CanonicalMarkdownDeliveryChunk[] {
  const chunk = deliveryChunk(canonicalText, input.render);
  if (chunk.renderedText.length <= input.maxRenderedCodeUnits) return [chunk];
  const wrapped = canonicalWrapper(canonicalText);
  if (!wrapped?.content) return splitCanonicalPlainText(canonicalText, input);

  const chunks: CanonicalMarkdownDeliveryChunk[] = [];
  const codePoints = Array.from(wrapped.content);
  let start = 0;
  while (start < codePoints.length) {
    const accepted = largestCanonicalPrefix({
      codePoints,
      start,
      maxRenderedCodeUnits: input.maxRenderedCodeUnits,
      render: input.render,
      wrap: (content) => `${wrapped.prefix}${content}${wrapped.suffix}`,
    });
    if (!accepted) {
      return splitCanonicalPlainText(
        wrapped.unwrappedText ?? wrapped.content,
        input,
      );
    }
    chunks.push(
      deliveryChunk(
        `${wrapped.prefix}${accepted}${wrapped.suffix}`,
        input.render,
      ),
    );
    start += Array.from(accepted).length;
  }
  return chunks;
}

function splitCanonicalPlainText(
  canonicalText: string,
  input: {
    maxRenderedCodeUnits: number;
    render: (canonicalText: string) => string;
  },
): CanonicalMarkdownDeliveryChunk[] {
  const codePoints = Array.from(canonicalText);
  const chunks: CanonicalMarkdownDeliveryChunk[] = [];
  let start = 0;
  while (start < codePoints.length) {
    const accepted = largestCanonicalPrefix({
      codePoints,
      start,
      maxRenderedCodeUnits: input.maxRenderedCodeUnits,
      render: input.render,
      wrap: (text) => text,
    });
    if (!accepted) break;
    chunks.push(deliveryChunk(accepted, input.render));
    start += Array.from(accepted).length;
  }
  return chunks;
}

function largestCanonicalPrefix(input: {
  codePoints: string[];
  start: number;
  maxRenderedCodeUnits: number;
  render: (canonicalText: string) => string;
  wrap: (content: string) => string;
}): string {
  let low = 1;
  let high = input.codePoints.length - input.start;
  let accepted = '';
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const candidate = input.codePoints
      .slice(input.start, input.start + size)
      .join('');
    const rendered = input.render(input.wrap(candidate));
    if (rendered.length <= input.maxRenderedCodeUnits) {
      accepted = candidate;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  return accepted;
}

function deliveryChunk(
  canonicalText: string,
  render: (canonicalText: string) => string,
): CanonicalMarkdownDeliveryChunk {
  return { canonicalText, renderedText: render(canonicalText) };
}

function canonicalWrapper(text: string):
  | {
      prefix: string;
      content: string;
      suffix: string;
      unwrappedText?: string;
    }
  | undefined {
  if (text.startsWith('```') && text.endsWith('```')) {
    const firstNewline = text.indexOf('\n');
    const prefix = firstNewline >= 0 ? text.slice(0, firstNewline + 1) : '```';
    return { prefix, content: text.slice(prefix.length, -3), suffix: '```' };
  }
  if (text.startsWith('`') && text.endsWith('`')) {
    return { prefix: '`', content: text.slice(1, -1), suffix: '`' };
  }
  const link = /^\[([\s\S]+)]\(([\s\S]+)\)$/.exec(text);
  if (link) {
    return {
      prefix: '[',
      content: link[1],
      suffix: `](${link[2]})`,
      unwrappedText: `${link[1]}\n${link[2]}`,
    };
  }
  const underline = /^<u>([\s\S]+)<\/u>$/.exec(text);
  if (underline) {
    return { prefix: '<u>', content: underline[1], suffix: '</u>' };
  }
  const heading = /^#{1,6}\s+([\s\S]+)$/.exec(text);
  if (heading) {
    return { prefix: '**', content: heading[1], suffix: '**' };
  }
  for (const marker of ['***', '___', '**', '__', '||', '*', '_', '~']) {
    if (text.startsWith(marker) && text.endsWith(marker)) {
      return {
        prefix: marker,
        content: text.slice(marker.length, -marker.length),
        suffix: marker,
      };
    }
  }
  return undefined;
}
