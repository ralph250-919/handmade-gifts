import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    env: { POWERTOOLS_METRICS_DISABLED: 'true', POWERTOOLS_TRACE_ENABLED: 'false', POWERTOOLS_LOG_LEVEL: 'SILENT' },
  },
});
