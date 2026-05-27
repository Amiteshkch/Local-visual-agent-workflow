import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    open: false,
  },
  build: {
    rollupOptions: {
      input: {
        main:     path.resolve("index.html"),
        workflow: path.resolve("workflow.html"),
      },
    },
  },
});
