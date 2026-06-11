import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Array form so string and regex matchers can coexist.
    // jsconfig maps these but Vitest doesn't read jsconfig paths.
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, "./src/") + "/" },
      { find: /^open-sse$/, replacement: path.resolve(__dirname, "./open-sse/index.js") },
      { find: /^open-sse\//, replacement: path.resolve(__dirname, "./open-sse/") + "/" },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
    globals: false,
  },
});
