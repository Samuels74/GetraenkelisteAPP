import path from "node:path";
import { defineConfig } from "vitest/config";

// When TEST_RESULTS_DIR is set (CI / `make test`), a JUnit report is written to
// $TEST_RESULTS_DIR/api/junit.xml in addition to the console output.
const resultsDir = process.env.TEST_RESULTS_DIR;

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./setup/global-setup.ts"],
    // all files share one PocketBase instance; every test creates its own data
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: resultsDir ? ["default", "junit"] : ["default"],
    outputFile: resultsDir ? { junit: path.resolve(resultsDir, "api", "junit.xml") } : undefined,
  },
});
