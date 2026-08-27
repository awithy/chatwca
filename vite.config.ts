import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverTarget = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": serverTarget,
      "/ws": {
        target: serverTarget,
        ws: true,
      },
    },
  },
});
