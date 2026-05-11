export function isTransientExtractorError(err: unknown): boolean {
  const status = extractStatusCode(err);
  if (status === 429 || status === 503) return true;
  if (err instanceof Error) {
    return /\b(429|503|rate limit|temporar(?:y|ily)?|timeout|econnreset|etimedout|service unavailable)\b/i.test(
      err.message,
    );
  }
  return false;
}

function extractStatusCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const direct = Number(candidate.status);
  if (Number.isFinite(direct)) return direct;
  const nested = Number(candidate.response?.status);
  return Number.isFinite(nested) ? nested : null;
}
