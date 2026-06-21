import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import zipPack from "vite-plugin-zip-pack";

export default defineConfig({
  plugins: [react(), zipPack()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});
