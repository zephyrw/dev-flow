import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export function parsePort(raw: string | undefined, defaultPort: number): number {
  if (!raw || !raw.trim()) return defaultPort;
  const num = Number(raw.trim());
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`无效的本地服务端口: ${raw}`);
  }
  return num;
}

const webPort = parsePort(process.env.DEVFLOW_WEB_PORT, 5173);
const apiPort = parsePort(process.env.DEVFLOW_API_PORT, 4810);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
