// Cloudflare Pages Function: /p/<id> で写真・動画ごとの OG 情報を返す。
// 中身は index.html そのもので、og:title / og:description / og:image / og:url だけ差し替える。
// ブラウザ側(main.ts)は location.pathname の /p/<id> を見てその写真を開く。
let mediaCache = null;

async function loadMedia(env, origin) {
  if (mediaCache) return mediaCache;
  const r = await env.ASSETS.fetch(new Request(`${origin}/data/media.json`));
  const data = await r.json();
  mediaCache = new Map(data.items.map((it) => [it.id, it]));
  return mediaCache;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function fmtTime(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  return m ? `${Number(m[2])}月${Number(m[3])}日 ${Number(m[4])}:${m[5]}` : "";
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const origin = url.origin;
  const id = String(params.id || "").replace(/[^a-z0-9_]/g, "");
  const page = await env.ASSETS.fetch(new Request(`${origin}/index.html`));
  let html = await page.text();
  const items = await loadMedia(env, origin);
  const it = items.get(id);
  if (it && !it.hidden) {
    const when = fmtTime(it.time);
    const title = `${when} ${it.type === "video" ? "の動画" : "の写真"} — 2017 川下り`;
    const desc = `山谷川の源流から石巻の海まで。${when}に撮影。`;
    const image = `${origin}/media/web/${it.id}.jpg`;
    html = html
      .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(title)}"`)
      .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(desc)}"`)
      .replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${esc(image)}"`)
      .replace(/<meta property="og:image:width" content="[^"]*"/, `<meta property="og:image:width" content="${it.w >= it.h ? 1600 : Math.round((1600 * it.w) / it.h)}"`)
      .replace(/<meta property="og:image:height" content="[^"]*"/, `<meta property="og:image:height" content="${it.w >= it.h ? Math.round((1600 * it.h) / it.w) : 1600}"`)
      .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${esc(`${origin}/p/${it.id}`)}"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
