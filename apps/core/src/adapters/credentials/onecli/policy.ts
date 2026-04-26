import {
  validateBrokerUrl,
  type BrokerUrlValidationResult,
} from '../../../config/credentials/broker-url-policy.js';

export type OnecliUrlValidationResult = BrokerUrlValidationResult;

export function validateOnecliUrl(
  rawUrl: string,
  label = 'ONECLI_URL',
): OnecliUrlValidationResult {
  return validateBrokerUrl(rawUrl, label);
}

export function assertValidOnecliUrl(rawUrl: string): string {
  const result = validateOnecliUrl(rawUrl);
  if (!result.ok || !result.normalizedUrl) {
    throw new Error(result.error || 'Invalid ONECLI_URL.');
  }
  return result.normalizedUrl;
}
