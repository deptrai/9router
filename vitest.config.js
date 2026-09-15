import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Array form so string and regex matchers can coexist.
    // jsconfig maps these but Vitest doesn't read jsconfig paths.
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, "./apps/legacy/src/") + "/" },
      { find: /^open-sse$/, replacement: path.resolve(__dirname, "./apps/legacy/open-sse/index.js") },
      { find: /^open-sse\//, replacement: path.resolve(__dirname, "./apps/legacy/open-sse/") + "/" },
      { find: /^\.\.\/\.\.\/src\//, replacement: path.resolve(__dirname, "./apps/legacy/src/") + "/" },
      { find: /^\.\.\/\.\.\/open-sse\//, replacement: path.resolve(__dirname, "./apps/legacy/open-sse/") + "/" },
      { find: /^jose$/, replacement: path.resolve(__dirname, "./node_modules/jose") },
      { find: /^next\/headers$/, replacement: path.resolve(__dirname, "./node_modules/next/headers.js") },
      { find: /^next\/server$/, replacement: path.resolve(__dirname, "./node_modules/next/server.js") },
    ],
  },
  server: {
    deps: {
      inline: [/jose/, /next/],
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
    globals: false,
  },
});
