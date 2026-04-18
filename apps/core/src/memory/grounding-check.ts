const TOKEN_PATTERN =
  /\b(?:[a-zA-Z_][a-zA-Z0-9_./:-]{2,}|[0-9]{2,}|[a-z]+-[a-z0-9-]{2,})\b/g;

const STOP_TOKENS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'have',
  'will',
  'were',
  'been',
  'into',
  'about',
  'after',
  'before',
  'where',
  'which',
  'their',
  'there',
  'should',
  'could',
  'would',
  'because',
  'while',
  'when',
  'what',
  'your',
  'they',
  'them',
  'than',
  'then',
  'over',
  'under',
  'more',
  'most',
  'less',
  'very',
  'true',
  'false',
  'none',
]);

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function requiresStrictGrounding(token: string): boolean {
  return /[0-9_./:]/.test(token) || token.includes('-');
}

export function extractGroundingTokens(text: string): string[] {
  const tokens = text.match(TOKEN_PATTERN) || [];
  return tokens
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));
}

export function firstUngroundedToken(
  candidateText: string,
  sourceTexts: string[],
): string | null {
  const sourceTokenSet = new Set<string>();
  for (const text of sourceTexts) {
    for (const token of extractGroundingTokens(text)) {
      sourceTokenSet.add(token);
    }
  }
  for (const token of extractGroundingTokens(candidateText)) {
    if (!requiresStrictGrounding(token)) {
      continue;
    }
    if (!sourceTokenSet.has(token)) {
      return token;
    }
  }
  return null;
}
