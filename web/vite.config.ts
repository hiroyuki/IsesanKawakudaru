import { defineConfig, type Plugin } from "vite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EXCLUDE_PATH = resolve(__dirname, "../data/exclude.json");

/** 開発時だけ: /curate.html からの除外リストの読み書き(data/exclude.json) */
function curatePlugin(): Plugin {
  return {
    name: "curate-exclude-file",
    configureServer(server) {
      server.middlewares.use("/__curate/load", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(existsSync(EXCLUDE_PATH) ? readFileSync(EXCLUDE_PATH, "utf8") : '{"ids":[]}');
      });
      server.middlewares.use("/__curate/save", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        // 書き込みは「この Mac のブラウザから、同一オリジンで」だけ許す。LAN 上の他端末や他サイトからの POST は拒否
        const addr = req.socket.remoteAddress ?? "";
        const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
        const host = req.headers.host ?? "";
        const origin = req.headers.origin;
        const sameOrigin = !origin || origin === `http://${host}`;
        const localHost = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host);
        const isJson = (req.headers["content-type"] ?? "").startsWith("application/json");
        if (!loopback || !sameOrigin || !localHost || !isJson) { res.statusCode = 403; res.end("forbidden"); return; }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const ids = (JSON.parse(body) as { ids: unknown }).ids;
            if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new Error("ids must be string[]");
            mkdirSync(resolve(EXCLUDE_PATH, ".."), { recursive: true });
            writeFileSync(EXCLUDE_PATH, JSON.stringify({ ids: [...ids].sort() }, null, 1) + "\n");
            res.end("ok");
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [curatePlugin()],
  server: {
    host: true,
    port: 5173,
    // 開発時: /media/* を縮小画像サーバー(npm run media)へ中継し、同一オリジンにする(canvas 汚染を避ける)
    proxy: { "/media": { target: "http://localhost:8788", rewrite: (p) => p.replace(/^\/media/, "") } },
  },
  // 本番ビルドは index.html だけ(curate.html は開発専用)
  build: { target: "es2020", rollupOptions: { input: { main: resolve(__dirname, "index.html") } } },
});
