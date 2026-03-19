import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  envDir: resolve(__dirname, "..", ".."),
  define: {
    __SPELLTABLE_ONLY__: "true",
  },
  server: {
    port: 5174,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(__dirname, "tailwind.config.cjs") }),
        autoprefixer(),
      ],
    },
  },
});
