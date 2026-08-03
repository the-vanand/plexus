import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Конфигурация Vite для Plexus.
// В режиме Tauri дев-сервер должен иметь фиксированный порт (см. src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // ВАЖНО: не следить за src-tauri — cargo пишет туда артефакты сборки,
      // и на Windows наблюдатель Vite падает с EBUSY на залоченных .exe
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
