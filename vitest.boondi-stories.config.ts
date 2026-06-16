import { makeVitestConfig } from './vitest.shared.js';

export default makeVitestConfig({
  include: ['packages/mcp-shopify/test/stories/**/*.test.ts'],
});
