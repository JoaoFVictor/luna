import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "markdown-as-string",
      transform(code, id) {
        if (!id.endsWith(".md")) {
          return null;
        }

        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null
        };
      }
    }
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000
  }
});
