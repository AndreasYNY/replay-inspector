import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // The osu-parsers submodule is a nested package that pulls its own copy of
    // osu-classes (a peer dep). Dedupe so all imports resolve to the single
    // root copy (3.2.0-beta.0), avoiding duplicate/mismatched class instances.
    dedupe: ["osu-classes"],
  },
});
