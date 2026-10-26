import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows updates run three bounded ACL subprocesses. The test must outlive their
    // combined deadline, otherwise cleanup races a still-running security operation.
    testTimeout: process.platform === 'win32' ? 90_000 : 5_000,
  },
});
