/*
 * 選別ページ(開発時のみ /curate.html)。
 * 動画と GPS の無い写真を日ごとに並べ、クリックで除外をトグルし、data/exclude.json に保存する。
 * 保存は vite.config.ts の開発用ミドルウェア(/__curate/save)が受ける。
 */
import "./curate.css";

type Item = {
  id: string; file: string; type: "photo" | "video"; time: string | null; day: string | null;
  gps: string | null; camera: string; w: number; h: number; duration?: number;
};

const MEDIA_BASE = (import.meta.env.VITE_MEDIA_BASE as string | undefined) ?? "/media";
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let items: Item[] = [];
let excluded = new Set<string>();
let dirty = false;

/** 自動候補: 川下りの素材らしくないものの理由を返す(なければ null) */
function candidateReason(it: Item): string | null {
  if (it.type !== "video") return null;
  if (!it.camera && !/^(MVI_|IMG_|GOPR|G\d{7})/i.test(it.file)) return "機種不明・別アプリ書き出し";
  if (it.w === it.h) return "正方形";
  if (it.h > it.w) return "縦長";
  const h = it.time ? Number(it.time.slice(11, 13)) : 12;
  if (h < 5 || h >= 21) return "深夜";
  return null;
}

function fmt(iso: string | null): string {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}` : "時刻不明";
}

function render() {
  const onlyVideo = ($("#only-video") as HTMLInputElement).checked;
  const showEx = ($("#show-excluded") as HTMLInputElement).checked;
  const list = items.filter((it) => (onlyVideo ? it.type === "video" : true) && (showEx || !excluded.has(it.id)));
  const grid = $("#grid");
  grid.innerHTML = "";
  // 自動候補を先頭に、その後は日ごと
  const cands = list.filter((it) => candidateReason(it));
  const rest = list.filter((it) => !candidateReason(it));
  let day = "";
  const ordered = [...cands, ...rest];
  for (const it of ordered) {
    const why = candidateReason(it);
    const group = why ? "候補" : it.day ?? "不明";
    if (group !== day) {
      day = group;
      const h = document.createElement("h2");
      h.textContent = why ? `自動候補 ${cands.length} 件(機種不明・縦長・正方形・深夜)` : day;
      h.classList.toggle("cand", !!why);
      grid.appendChild(h);
    }
    const card = document.createElement("figure");
    card.className = "card";
    card.dataset.id = it.id;
    card.classList.toggle("excluded", excluded.has(it.id));
    if (why) {
      const tag = document.createElement("span");
      tag.className = "why";
      tag.textContent = why;
      card.appendChild(tag);
    }
    if (it.type === "video") {
      const v = document.createElement("video");
      v.src = `${MEDIA_BASE}/video/${it.id}.mp4`;
      v.poster = `${MEDIA_BASE}/web/${it.id}.jpg`;
      v.preload = "metadata";
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute("muted", ""); // 属性も付けないと自動再生が拒否されるブラウザがある
      // カードのどこにマウスが乗っても再生、外れたら先頭に戻して停止
      card.addEventListener("mouseenter", () => {
        card.classList.add("playing");
        // 音あり: ブラウザはクリック無しの音付き自動再生を禁止するので、チェック(クリック)済みのときだけ音を出す
        v.muted = !($("#sound") as HTMLInputElement).checked;
        v.play().catch((e: Error) => { card.classList.remove("playing"); card.title = `再生できません: ${e.message}`; });
      });
      card.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; card.classList.remove("playing"); });
      // タッチ端末: タップで再生/停止(除外のトグルは長押し)
      card.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = `${MEDIA_BASE}/thumb/${it.id}.jpg`;
      img.loading = "lazy";
      img.alt = "";
      card.appendChild(img);
    }
    const cap = document.createElement("figcaption");
    const kind = it.type === "video" ? `動画 ${it.duration ?? "?"}s` : `写真(位置: ${it.gps ?? "なし"})`;
    const b = document.createElement("b");
    b.textContent = fmt(it.time);
    const span = document.createElement("span");
    span.textContent = `${it.file}・${it.camera || "機種不明"}・${it.w}×${it.h}`;
    cap.append(b, document.createElement("br"), kind, document.createElement("br"), span);
    card.appendChild(cap);
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "VIDEO" && e.detail > 1) return;
      toggle(it.id, card);
    });
    grid.appendChild(card);
  }
  updateStat();
}

let saveTimer: number | undefined;
function toggle(id: string, card: HTMLElement) {
  if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
  card.classList.toggle("excluded", excluded.has(id));
  dirty = true;
  updateStat();
  try { localStorage.setItem("exclude-ids", JSON.stringify([...excluded])); } catch { /* 無視 */ }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 400); // クリックのたびに自動保存
}

function updateStat() {
  const v = items.filter((i) => i.type === "video");
  const exV = v.filter((i) => excluded.has(i.id)).length;
  const exP = items.filter((i) => i.type === "photo" && excluded.has(i.id)).length;
  $("#stat").textContent = `除外: 動画 ${exV} / ${v.length}、写真 ${exP}${dirty ? "(未保存)" : ""}`;
}

let lastSaved = ""; // 最後にサーバーへ書けた内容(ソート済み JSON)
function serialize(): string {
  return JSON.stringify({ ids: [...excluded].sort() }, null, 1);
}

async function save() {
  const body = serialize();
  const r = await fetch("/__curate/save", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (r.ok) {
    lastSaved = body;
    // 保存中にさらに変更があれば未保存のまま(古い保存の完了で新しい変更を「保存済み」にしない)
    dirty = serialize() !== lastSaved;
    $("#saved").textContent = dirty ? "保存中…" : `保存済み(${excluded.size} 件)`;
  } else {
    $("#saved").textContent = `保存に失敗: ${r.status} ${await r.text()}`;
  }
  updateStat();
}

async function main() {
  const data = (await (await fetch("/data/media.json")).json()) as { items: Item[] };
  items = data.items.filter((it) => it.type === "video" || it.gps !== "exif");
  try {
    const ex = (await (await fetch("/__curate/load")).json()) as { ids?: string[] };
    excluded = new Set(ex.ids ?? []);
    lastSaved = serialize();
  } catch { /* 無ければ空 */ }
  if (excluded.size === 0) {
    // 前回ブラウザ上で付けた印が保存されていなければ復元する
    try {
      const local = JSON.parse(localStorage.getItem("exclude-ids") ?? "[]") as string[];
      if (local.length) { excluded = new Set(local); save(); }
    } catch { /* 無視 */ }
  }
  render();
  $("#only-video").addEventListener("change", render);
  $("#show-excluded").addEventListener("change", render);
  $("#btn-save").addEventListener("click", save);
  $("#btn-cands").addEventListener("click", () => {
    for (const it of items) if (candidateReason(it)) excluded.add(it.id);
    dirty = true;
    render();
    save();
  });
  window.addEventListener("beforeunload", (e) => { if (dirty || serialize() !== lastSaved) e.preventDefault(); });
}
main();
