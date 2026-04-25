export function formatMemoryToolResponse(response: {
  provider?: string;
  data?: unknown;
}): string {
  return JSON.stringify(
    {
      provider: response.provider || 'unknown',
      ...(typeof response.data === 'object' &&
      response.data !== null &&
      !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : { data: response.data }),
    },
    null,
    2,
  );
}

export function formatBrowserToolResponse(response: {
  data?: unknown;
}): string {
  if (
    typeof response.data === 'object' &&
    response.data !== null &&
    !Array.isArray(response.data)
  ) {
    return JSON.stringify(response.data, null, 2);
  }
  return JSON.stringify({ data: response.data }, null, 2);
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

export function formatTaskFailureLines(
  response: { code?: string; details?: string[]; error?: string },
  fallbackError: string,
): string[] {
  const lines = [response.error || fallbackError];
  if (response.code) {
    lines.push(`code: ${response.code}`);
  }
  if (response.details && response.details.length > 0) {
    lines.push(...response.details.map((item) => `- ${item}`));
  }
  return lines;
}
