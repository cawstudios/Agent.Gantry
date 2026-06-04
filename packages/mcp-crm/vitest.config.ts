import { defineConfig } from 'vitest/config';

// Self-contained test config so the package runs independently of the root
// Gantry vitest setup. Keeps boondi-crm a clean, separately-testable unit.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
