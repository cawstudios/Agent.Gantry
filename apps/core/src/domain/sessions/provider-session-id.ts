export function isSafeProviderSessionId(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return true;
}

export function assertSafeProviderSessionId(value: string): void {
  if (!isSafeProviderSessionId(value)) {
    throw new Error(`Invalid provider session id: ${value}`);
  }
}
