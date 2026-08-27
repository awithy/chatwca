import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/{unit,integration}/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
