import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // 開発時: /media/* を縮小画像サーバー(npm run media)へ中継し、同一オリジンにする(canvas 汚染を避ける)
    proxy: { "/media": { target: "http://localhost:8788", rewrite: (p) => p.replace(/^\/media/, "") } },
  },
  build: { target: "es2020" },
});
