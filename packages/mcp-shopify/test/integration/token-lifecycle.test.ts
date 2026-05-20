import { describe, expect, it } from 'vitest';
import { TokenManager } from '../../src/auth/token-manager.js';
import { loadDotenvUpwards } from '../../src/dotenv-load.js';

loadDotenvUpwards();

const LIVE = process.env.SHOPIFY_LIVE === '1';
const HAS_CREDS =
  !!process.env.SHOPIFY_DEV_SHOP_DOMAIN &&
  !!process.env.SHOPIFY_DEV_CLIENT_ID &&
  !!process.env.SHOPIFY_DEV_CLIENT_SECRET;

describe.skipIf(!(LIVE && HAS_CREDS))(
  'token-lifecycle (live Shopify)',
  () => {
    it('acquires a token from the Shopify OAuth endpoint', async () => {
      const mgr = new TokenManager({
        shopDomain: process.env.SHOPIFY_DEV_SHOP_DOMAIN!,
        clientId: process.env.SHOPIFY_DEV_CLIENT_ID!,
        clientSecret: process.env.SHOPIFY_DEV_CLIENT_SECRET!,
      });
      try {
        const token = await mgr.getToken();
        expect(token).toMatch(/^shp(?:at|ca|ua|pa)_/);
      } finally {
        mgr.stop();
      }
    });

    it('caches the token across calls within the refresh window', async () => {
      const mgr = new TokenManager({
        shopDomain: process.env.SHOPIFY_DEV_SHOP_DOMAIN!,
        clientId: process.env.SHOPIFY_DEV_CLIENT_ID!,
        clientSecret: process.env.SHOPIFY_DEV_CLIENT_SECRET!,
      });
      try {
        const a = await mgr.getToken();
        const b = await mgr.getToken();
        expect(a).toBe(b);
      } finally {
        mgr.stop();
      }
    });
  },
);

it('placeholder so integration test file always runs without LIVE env', () => {
  if (!LIVE || !HAS_CREDS) {
    expect(LIVE && HAS_CREDS).toBe(false);
  } else {
    expect(true).toBe(true);
  }
});
