import crypto from 'crypto';

const MAX_INIT_DATA_AGE_SECONDS = 60 * 60; // 1 hour
const MAX_FUTURE_SKEW_SECONDS = 5 * 60; // tolerate clock skew

export interface TelegramInitDataValidation {
  valid: boolean;
  userId?: string;
  username?: string;
  firstName?: string;
  authDate?: number;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
): TelegramInitDataValidation {
  if (!initData || !botToken) return { valid: false };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false };

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const valid = timingSafeEqualHex(calculatedHash, hash);
  if (!valid) return { valid: false };

  const userRaw = params.get('user');
  const authDateRaw = params.get('auth_date');
  let userId: string | undefined;
  let username: string | undefined;
  let firstName: string | undefined;

  if (userRaw) {
    try {
      const parsed = JSON.parse(userRaw) as {
        id?: number | string;
        username?: string;
        first_name?: string;
      };
      if (parsed.id !== undefined) userId = String(parsed.id);
      if (parsed.username) username = parsed.username;
      if (parsed.first_name) firstName = parsed.first_name;
    } catch {
      // Ignore malformed user payload while keeping auth valid.
    }
  }

  const parsedAuthDate = authDateRaw
    ? Number.parseInt(authDateRaw, 10)
    : Number.NaN;
  if (!Number.isFinite(parsedAuthDate)) {
    return { valid: false };
  }
  const authDate = parsedAuthDate;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - authDate;
  if (
    ageSeconds > MAX_INIT_DATA_AGE_SECONDS ||
    ageSeconds < -MAX_FUTURE_SKEW_SECONDS
  ) {
    return { valid: false };
  }

  return {
    valid: true,
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
    authDate,
  };
}
