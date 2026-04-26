import {
  validateBrokerUrl,
  type BrokerUrlValidationResult,
} from '../../../config/credentials/broker-url-policy.js';

export type OnecliUrlValidationResult = BrokerUrlValidationResult;

export function validateOnecliUrl(rawUrl: string): OnecliUrlValidationResult {
  return validateBrokerUrl(rawUrl, 'ONECLI_URL');
}

export function assertValidOnecliUrl(rawUrl: string): string {
  const result = validateOnecliUrl(rawUrl);
  if (!result.ok || !result.normalizedUrl) {
    throw new Error(result.error || 'Invalid ONECLI_URL.');
  }
  return result.normalizedUrl;
}
