import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

/*
 * 設計
 *  - 画面を上下に二分。上 = 写真、下 = 地図。地図には軌跡(赤線)と日付ラベルだけを描き、写真のピンは置かない。
 *  - 軌跡をクリック/タップすると、その場所で撮った写真が上に出る(split)。軌跡から離れた所をタップすると閉じる(map)。
 *  - PC では軌跡にマウスを乗せるとサムネイルと日時が小さく出る(写真は切り替えない)。軌跡上には点。
 *  - 前後ボタン・矢印キー・写真の左右スワイプで時刻順に移動。写真が地図の外に出たら地図が追う。
 *  - 見え方は 3 つ: map(読み込み時、地図のみ。スライダーも出さない) → 写真が選ばれると split(上=写真 下=地図) → 写真タップで photo(写真のみ)。× で 1 段階戻る。
 *  - 上下の間にタイムラインのスライダー。左端が旅の始まり、右端が終わり。ドラッグで時刻順に写真を送る(スマホ向け)。
 *  - 日付チップで日ごとに絞り込み。軌跡は時間が空いた所・瞬間移動の所で切る。
 */

type MediaItem = {
  id: string;
  file: string;
  type: "photo" | "video";
  time: string | null;
  day: string | null;
  lat: number | null;
  lon: number | null;
  gps: "exif" | "interp" | "nearest" | null;
  camera: string;
  w: number;
  h: number;
  duration?: number;
  hidden?: boolean; // 選別で除外(data/exclude.json)
  li: number; // located 内の添字(軌跡・画面座標用)
  vi: number; // visible 内の添字(フィルタごとに振り直す)
};
type Kind = "all" | "photo" | "video";

const MEDIA_BASE = (import.meta.env.VITE_MEDIA_BASE as string | undefined) ?? "/media"; // thumb/ web/ の置き場所
const VIDEO_BASE = (import.meta.env.VITE_VIDEO_BASE as string | undefined) ?? `${MEDIA_BASE}/video`; // 本番は R2
const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const RIVER_ATTR = '<a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html" target="_blank" rel="noopener">国土数値情報(河川データ)</a>(国土交通省)';
const TRACK_GAP_MS = 60 * 60 * 1000;
const MIN_DAY_ITEMS = 10; // これより少ない日(8/4 の 2 枚、7/31 の前日分など)は扱わない
// 軌跡を切る条件: 連続する写真の間が 1 km 以上離れていたら線を引かない(速度は見ない)
const JUMP_KM = 1.0;
const DOT_ZOOM = 14; // これ以上寄ったら軌跡の線をやめて写真を点で出す
const HOVER_RADIUS = 14; // px。線からこの距離以内でなぞりに反応
const TAP_RADIUS = 28; // px。タップ用に広め
const FULL_DELAY_MS = 180; // なぞっている間はサムネイル、止まったら大きい画像に差し替えるまでの時間
const COLORS = { river: "#2a6f97", track: "#d93e2c", video: "#7a3fa0", fav: "#ff5a7a", water: "#a9d3ea" };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let all: MediaItem[] = [];
let located: MediaItem[] = []; // 位置あり・日付フィルタ後・時刻順(写真も動画も)。軌跡はこれで描く
let visible: MediaItem[] = []; // located をさらに写真/動画で絞ったもの。送り・スライダーはこれ
let segments: MediaItem[][] = []; // 軌跡の区間(located)
let currentDay: string | null = null;
let currentKind: Kind = "all";
let favOnly = false;
const favs = new Set<string>(loadFavs()); // お気に入り(この端末のブラウザに保存)

function loadFavs(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem("fav-ids") ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function storeFavs() {
  try { localStorage.setItem("fav-ids", JSON.stringify([...favs])); } catch { /* 保存できない環境では諦める */ }
}
function favCount(): number { return located.filter((i) => favs.has(i.id)).length; }

/** プルダウンの選択肢に枚数を添える(日付で絞った範囲の数) */
function updateFilterLabels() {
  const photos = located.filter((i) => i.type === "photo").length;
  const labels: Record<string, string> = {
    all: `すべて ${located.length}`, photo: `写真 ${photos}`, video: `動画 ${located.length - photos}`, fav: `お気に入り ${favCount()}`,
  };
  for (const o of ($("#sel-kind") as HTMLSelectElement).options) o.textContent = labels[o.value];
}
let current: MediaItem | null = null;

type View = "map" | "split" | "photo";
const app = document.getElementById("app")!;
function setView(v: View) {
  app.dataset.view = v;
  $("#btn-close").setAttribute("aria-label", v === "photo" ? "分割表示に戻る" : "地図だけにする");
  if (v !== "photo") screenDirty = true; // 地図の大きさが変わるので画面座標を取り直す
}
const view = () => app.dataset.view as View;

// ---- 地図 ------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    glyphs: "/fonts/{fontstack}/{range}.pbf", // 日付ラベル用。0-255 の範囲だけ同梱
    sources: {
      pale: { type: "raster", tiles: [`${GSI}/pale/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 5, maxzoom: 18, attribution: ATTR },
      photo: { type: "raster", tiles: [`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`], tileSize: 256, minzoom: 2, maxzoom: 18, attribution: ATTR },
    },
    layers: [
      { id: "pale", type: "raster", source: "pale", paint: { "raster-saturation": -1, "raster-contrast": -0.15, "raster-opacity": 0.9 } },
      { id: "photo", type: "raster", source: "photo", layout: { visibility: "none" } },
    ],
  },
  center: [141.3, 38.95],
  zoom: 8,
  maxZoom: 18,
  attributionControl: false,
});
map.keyboard.disable(); // 矢印キーは写真送りに使う(地図のキー操作はオフ)
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = map;

// ---- GeoJSON ----------------------------------------------------------------
function distanceKm(a: MediaItem, b: MediaItem): number {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat! - a.lat!) * toR, dLon = (b.lon! - a.lon!) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat! * toR) * Math.cos(b.lat! * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 軌跡の区間。時間が空いた所と瞬間移動の所で切る */
function trackSegments(items: MediaItem[]): MediaItem[][] {
  const segs: MediaItem[][] = [];
  let cur: MediaItem[] = [];
  let prev: MediaItem | null = null;
  for (const it of items) {
    if (!it.time) continue;
    if (prev && cur.length) {
      const gapMs = Date.parse(it.time) - Date.parse(prev.time!);
      if (gapMs > TRACK_GAP_MS || distanceKm(prev, it) >= JUMP_KM) {
        segs.push(cur);
        cur = [];
      }
    }
    cur.push(it);
    prev = it;
  }
  if (cur.length) segs.push(cur);
  return segs.filter((s) => s.length > 1);
}

function trackGeoJSON(segs: MediaItem[][]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: segs.map((s) => ({ type: "Feature", geometry: { type: "LineString", coordinates: s.map((it) => [it.lon!, it.lat!]) }, properties: {} })),
  };
}

function daysGeoJSON(items: MediaItem[]): GeoJSON.FeatureCollection {
  const byDay = new Map<string, MediaItem[]>();
  for (const it of items) if (it.day) (byDay.get(it.day) ?? byDay.set(it.day, []).get(it.day)!).push(it);
  return {
    type: "FeatureCollection",
    features: [...byDay.entries()].map(([day, list]) => {
      const mid = list[Math.floor(list.length / 2)]; // その日の真ん中の写真の位置(軌跡の上)
      return { type: "Feature", geometry: { type: "Point", coordinates: [mid.lon!, mid.lat!] }, properties: { label: dayLabel(day) } };
    }),
  };
}

function pointsGeoJSON(items: MediaItem[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: items.map((it) => ({ type: "Feature", geometry: { type: "Point", coordinates: [it.lon!, it.lat!] }, properties: {} })) };
}

function pointGeoJSON(item: MediaItem | null): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: item ? [{ type: "Feature", geometry: { type: "Point", coordinates: [item.lon!, item.lat!] }, properties: {} }] : [] };
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

// ---- 表示状態 ---------------------------------------------------------------
function applyFilter() {
  located = all.filter((it) => it.lat !== null && (currentDay === null || it.day === currentDay));
  located.forEach((it, i) => (it.li = i));
  visible = located.filter((it) => (currentKind === "all" || it.type === currentKind) && (!favOnly || favs.has(it.id)));
  updateFilterLabels();
  visible.forEach((it, i) => (it.vi = i));
  segments = trackSegments(located);
  (map.getSource("track") as GeoJSONSource).setData(trackGeoJSON(segments));
  (map.getSource("days") as GeoJSONSource).setData(daysGeoJSON(located));
  (map.getSource("videos") as GeoJSONSource).setData(pointsGeoJSON(located.filter((i) => i.type === "video")));
  (map.getSource("photos") as GeoJSONSource).setData(pointsGeoJSON(located.filter((i) => i.type === "photo")));
  (map.getSource("favs") as GeoJSONSource).setData(pointsGeoJSON(located.filter((i) => favs.has(i.id))));
  // 種類で絞っているときは、その素材だけを地図に出す(写真 = 軌跡、動画 = 紫の点)
  for (const l of ["track-casing", "track", "photo-dots"]) map.setLayoutProperty(l, "visibility", currentKind === "video" ? "none" : "visible");
  map.setLayoutProperty("video-dots", "visibility", currentKind === "photo" ? "none" : "visible");
  screenDirty = true;
  buildScrub();
}

function fitTo(items: MediaItem[]) {
  if (items.length === 0) return;
  const b = new maplibregl.LngLatBounds();
  for (const it of items) b.extend([it.lon!, it.lat!]);
  map.fitBounds(b, { padding: { top: 48, bottom: 40, left: 30, right: 30 }, duration: 700, maxZoom: 15 });
}

/** ISO 文字列(JST 固定、例 2017-08-01T06:27:00+09:00)の成分。Date に通すと閲覧者のタイムゾーンに変換されるので使わない */
function jst(iso: string): { month: number; day: number; hour: number; minute: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? { month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) } : null;
}

/** 何で撮ったか。EXIF の機種名を整え、無い動画はファイル名の規則から推定する */
function cameraName(item: MediaItem): string {
  const m = item.camera;
  if (/HERO5/i.test(m)) return "GoPro HERO5 Black";
  if (/iPhone/i.test(m)) return m;
  if (/XC10/i.test(m)) return "Canon XC10";
  if (/D300/i.test(m)) return "Nikon D300";
  if (m) return m;
  const f = item.file.toUpperCase();
  if (f.startsWith("MVI_")) return "Canon XC10";
  if (f.startsWith("GOPR") || /^G\d{7}\./.test(f)) return "GoPro HERO5 Black";
  if (f.startsWith("IMG_")) return "iPhone";
  return "";
}

function fmtTime(iso: string | null): string {
  const t = iso ? jst(iso) : null;
  if (!t) return "時刻不明";
  return `${t.month}月${t.day}日 ${t.hour}:${String(t.minute).padStart(2, "0")}`;
}

// ---- 写真パネル ---------------------------------------------------------------
const photoImg = $("#photo-img") as HTMLImageElement;
const photoVideo = $("#photo-video") as HTMLVideoElement;
let fullTimer: number | undefined;
let photoSpinTimer: number | undefined;
/** 読み込み中の輪(写真・動画共通) */
const setLoading = (on: boolean) => { if (on) $("#photo").dataset.loading = "1"; else delete $("#photo").dataset.loading; };
// 写真側の load/error は写真を見ているときだけ輪を消す(動画のときは隠れた img の完了で消さない)
const photoImgDone = () => { window.clearTimeout(photoSpinTimer); if (current?.type !== "video") setLoading(false); };
photoImg.addEventListener("load", photoImgDone);
photoImg.addEventListener("error", photoImgDone);

const videoUi = $("#video-ui");

/** 動画なら <video> に切り替えて自動再生(ポスターは閲覧用 JPEG)。写真なら video を止めて隠す */
function showVideo(item: MediaItem | null) {
  const photo = $("#photo");
  if (item && item.type === "video") {
    photo.dataset.type = "video";
    photoVideo.poster = `${MEDIA_BASE}/web/${item.id}.jpg`;
    photoVideo.src = `${VIDEO_BASE}/${item.id}.mp4`;
    photoVideo.hidden = false;
    videoUi.hidden = false;
    $("#video-progress").style.width = "0";
    $("#video-knob").style.left = "0";
    $("#video-time").textContent = `0:00 / ${fmtClock(item.duration ?? 0)}`;
    photoVideo.play().catch(() => { /* 自動再生が拒否されたら再生ボタンを待つ */ });
  } else {
    photo.dataset.type = "photo";
    if (!photoVideo.hidden) { photoVideo.pause(); photoVideo.removeAttribute("src"); photoVideo.load(); }
    photoVideo.hidden = true;
    videoUi.hidden = true;
  }
}

// 再生 UI: タップで再生/一時停止、進行バーでシーク、音の ON/OFF
photoVideo.addEventListener("click", () => { if (photoVideo.paused) photoVideo.play(); else photoVideo.pause(); });
$("#btn-play").addEventListener("click", () => photoVideo.play());
photoVideo.addEventListener("play", () => { $("#photo").dataset.playing = "1"; });
photoVideo.addEventListener("pause", () => { delete $("#photo").dataset.playing; });
photoVideo.addEventListener("ended", () => { delete $("#photo").dataset.playing; });
function fmtClock(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function renderVideoTime() {
  const pct = photoVideo.duration ? (photoVideo.currentTime / photoVideo.duration) * 100 : 0;
  $("#video-progress").style.width = `${pct}%`;
  $("#video-knob").style.left = `${pct}%`;
  $("#video-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("#video-time").textContent = `${fmtClock(photoVideo.currentTime)} / ${fmtClock(photoVideo.duration)}`;
}
// 動画の読み込み中: データ待ちになったら出し、再生できる状態になったら消す
photoVideo.addEventListener("loadstart", () => setLoading(true));
photoVideo.addEventListener("waiting", () => setLoading(true));
photoVideo.addEventListener("seeking", () => setLoading(true));
for (const ev of ["canplay", "playing", "seeked", "pause", "error", "emptied"]) photoVideo.addEventListener(ev, () => setLoading(false));
photoVideo.addEventListener("timeupdate", renderVideoTime);
photoVideo.addEventListener("loadedmetadata", renderVideoTime);
$("#btn-pp").addEventListener("click", () => { if (photoVideo.paused) photoVideo.play(); else photoVideo.pause(); });
// シークバー: ドラッグ中は再生位置を追従させ、離した位置から再生を続ける
{
  const bar = $("#video-bar");
  let seeking = false, wasPlaying = false;
  const seekTo = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    if (!photoVideo.duration) return;
    photoVideo.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * photoVideo.duration;
    renderVideoTime();
  };
  bar.addEventListener("pointerdown", (e) => {
    seeking = true;
    wasPlaying = !photoVideo.paused;
    photoVideo.pause();
    bar.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  bar.addEventListener("pointermove", (e) => { if (seeking) seekTo(e.clientX); });
  const end = () => { if (!seeking) return; seeking = false; if (wasPlaying) photoVideo.play(); };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("keydown", (e) => {
    if (!photoVideo.duration) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.stopPropagation();
      photoVideo.currentTime = Math.max(0, Math.min(photoVideo.duration, photoVideo.currentTime + (e.key === "ArrowRight" ? 1 : -1)));
      e.preventDefault();
    }
  });
}
$("#btn-mute").addEventListener("click", (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  photoVideo.muted = !photoVideo.muted;
  b.setAttribute("aria-pressed", String(photoVideo.muted));
  b.setAttribute("aria-label", photoVideo.muted ? "音を出す" : "音を消す");
});

/** 写真を上半分に出す。follow=true なら地図の外にあるとき地図を寄せる */
function setCurrent(item: MediaItem, follow: boolean) {
  const changed = current !== item;
  current = item;
  if (view() === "map") setView("split"); // 写真が選ばれたら上半分を開く
  if (changed) {
    // なぞっている最中はサムネイル(軽い)。少し止まったら大きい画像に差し替える
    photoImg.src = `${MEDIA_BASE}/thumb/${item.id}.jpg`;
    if (item.type === "photo") {
      window.clearTimeout(photoSpinTimer);
      setLoading(false);
      photoSpinTimer = window.setTimeout(() => { if (!photoImg.complete) setLoading(true); }, 300);
    }
    photoImg.alt = fmtTime(item.time);
    window.clearTimeout(fullTimer);
    fullTimer = window.setTimeout(() => {
      const full = new Image();
      full.onload = () => { if (current === item) photoImg.src = full.src; };
      full.src = `${MEDIA_BASE}/web/${item.id}.jpg`;
    }, FULL_DELAY_MS);
    showVideo(item);
    $("#photo-time").textContent = fmtTime(item.time);
    const parts = [`${item.vi + 1} / ${visible.length}`];
    if (item.type === "video") parts.push(`動画 ${item.duration ?? "?"} 秒`);
    if (item.gps !== "exif") parts.push("位置は前後の写真から推定");
    $("#photo-sub").textContent = parts.join("・");
    $("#photo-camera").textContent = cameraName(item);
    $("#btn-fav").setAttribute("aria-pressed", String(favs.has(item.id)));
    ($("#btn-prev") as HTMLButtonElement).disabled = item.vi === 0;
    ($("#btn-next") as HTMLButtonElement).disabled = item.vi === visible.length - 1;
    (map.getSource("cursor") as GeoJSONSource).setData(pointGeoJSON(item));
    map.setPaintProperty("cursor", "circle-color", item.type === "video" ? COLORS.video : COLORS.track);
    updateScrub(item);
  }
  if (follow) {
    const p = map.project([item.lon!, item.lat!]);
    const c = map.getContainer();
    const inside = p.x > 40 && p.x < c.clientWidth - 40 && p.y > 48 && p.y < c.clientHeight - 40;
    if (!inside) map.easeTo({ center: [item.lon!, item.lat!], duration: 400 });
  }
}

/** フィルター変更後の表示を決める: 今の写真が残ればそれ、無ければ時刻の近いもの、何も無ければ閉じる */
function reselectAfterFilter(keep: MediaItem | null) {
  current = null;
  if (view() === "map") return;
  const next = keep ? toVisible(keep) : visible[0] ?? null;
  if (next) setCurrent(next, true);
  else { setView("map"); showVideo(null); }
}

function step(delta: number) {
  if (visible.length === 0) return;
  const next = current ? visible[current.vi + delta] : visible[0];
  if (next) setCurrent(next, true);
}

function buildFilters() {
  const days = [...new Set(all.map((i) => i.day).filter((d): d is string => !!d))].sort();
  const counts = new Map<string, number>();
  for (const it of all) if (it.day && it.lat !== null) counts.set(it.day, (counts.get(it.day) ?? 0) + 1);
  const selDay = $("#sel-day") as HTMLSelectElement;
  const mk = (value: string, label: string) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
  selDay.appendChild(mk("", `全日 ${all.filter((i) => i.lat !== null).length}`));
  for (const d of days) selDay.appendChild(mk(d, `${dayLabel(d)} ${counts.get(d) ?? 0}`));
  selDay.addEventListener("change", () => {
    currentDay = selDay.value || null;
    applyFilter();
    fitTo(visible);
    reselectAfterFilter(null); // 枚数・添字が変わるので表示を作り直す
  });

  const selKind = $("#sel-kind") as HTMLSelectElement;
  selKind.addEventListener("change", () => {
    const v = selKind.value;
    favOnly = v === "fav";
    currentKind = v === "fav" ? "all" : (v as Kind);
    const keep = current; // 今の写真が残るならそのまま、消えるなら時刻の近いものへ
    applyFilter();
    reselectAfterFilter(keep);
  });
}

// ---- ホバーのサムネイル(PC) ------------------------------------------------------
const hoverEl = $("#hover");
const hoverImg = $("#hover-img") as HTMLImageElement;
let hoverItem: MediaItem | null = null;

function hoverShow(item: MediaItem, ev: MouseEvent) {
  if (hoverItem !== item) {
    hoverItem = item;
    hoverImg.src = `${MEDIA_BASE}/thumb/${item.id}.jpg`;
    hoverEl.dataset.type = item.type;
    $("#hover-time").textContent = (item.type === "video" ? "動画 " : "") + fmtTime(item.time);
    (map.getSource("hover") as GeoJSONSource).setData(pointGeoJSON(item));
  }
  const W = hoverEl.offsetWidth || 180, H = hoverEl.offsetHeight || 165, M = 14;
  const x = ev.clientX + M + W > window.innerWidth ? ev.clientX - M - W : ev.clientX + M;
  const y = ev.clientY - H - M < 0 ? ev.clientY + M : ev.clientY - H - M; // 基本はカーソルの上に出す
  hoverEl.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  hoverEl.hidden = false;
}

function hoverHide() {
  if (hoverEl.hidden) return;
  hoverEl.hidden = true;
  hoverItem = null;
  (map.getSource("hover") as GeoJSONSource).setData(pointGeoJSON(null));
}

// ---- スライダー(タイムライン) ---------------------------------------------------
const scrub = $("#scrub");
const scrubDays = $("#scrub-days");
const scrubThumb = $("#scrub-thumb");

/** 日ごとの区間を枚数に比例した幅で並べる(1 枚あたりの幅が揃う) */
function buildScrub() {
  scrubDays.innerHTML = "";
  const counts = new Map<string, number>();
  for (const it of visible) counts.set(it.day!, (counts.get(it.day!) ?? 0) + 1);
  for (const [day, n] of counts) {
    const el = document.createElement("div");
    el.className = "scrub-day";
    el.style.flex = `${n} 0 0`;
    el.textContent = dayLabel(day);
    el.title = `${dayLabel(day)}: ${n} 枚`;
    scrubDays.appendChild(el);
  }
  // 時刻の目盛り: 3 時間ごとに、その時刻以降の最初の写真の位置へ(幅は枚数比例なので等間隔にはならない)
  const n = visible.length;
  let lastDay = "", lastSlot = -1;
  for (const it of visible) {
    const t = jst(it.time!);
    if (!t) continue;
    const slot = Math.floor(t.hour / 3);
    if (it.day !== lastDay) { lastDay = it.day!; lastSlot = slot; continue; } // 日の先頭は日付ラベルがあるので省く
    if (slot === lastSlot) continue;
    lastSlot = slot;
    const tick = document.createElement("div");
    tick.className = "scrub-tick";
    tick.style.left = `${((it.vi + 0.5) / n) * 100}%`;
    tick.dataset.label = `${slot * 3}`;
    scrubDays.appendChild(tick);
  }
  scrub.setAttribute("aria-valuemax", String(Math.max(1, n)));
  if (current) updateScrub(current);
  thinTickLabels();
}

/** 目盛りのラベルが重なるときは間引く(表示幅が変わるたびに) */
function thinTickLabels() {
  const ticks = [...scrubDays.querySelectorAll<HTMLElement>(".scrub-tick")];
  let lastX = -Infinity;
  for (const t of ticks) {
    const x = t.getBoundingClientRect().left;
    const show = x - lastX >= 22;
    t.classList.toggle("no-label", !show);
    if (show) lastX = x;
  }
}

function scrubInnerRect() {
  const r = scrubDays.getBoundingClientRect();
  return { left: r.left, width: Math.max(1, r.width) };
}

function updateScrub(item: MediaItem) {
  const n = visible.length;
  const frac = n > 1 ? (item.vi + 0.5) / n : 0.5;
  const { left, width } = scrubInnerRect();
  const sr = scrub.getBoundingClientRect();
  scrubThumb.style.left = `${left - sr.left + frac * width}px`;
  scrub.setAttribute("aria-valuenow", String(item.vi + 1));
  scrub.setAttribute("aria-valuetext", fmtTime(item.time));
}

function scrubAt(clientX: number) {
  const { left, width } = scrubInnerRect();
  const frac = Math.max(0, Math.min(0.999999, (clientX - left) / width));
  const item = visible[Math.floor(frac * visible.length)];
  if (item) setCurrent(item, true);
}

{
  let dragging = false;
  scrub.addEventListener("pointerdown", (e) => {
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  });
  scrub.addEventListener("pointermove", (e) => { if (dragging) scrubAt(e.clientX); });
  const end = () => { dragging = false; };
  scrub.addEventListener("pointerup", end);
  scrub.addEventListener("pointercancel", end);
  window.addEventListener("resize", () => { if (current) updateScrub(current); thinTickLabels(); });
}

// ---- 軌跡上の最近傍 ---------------------------------------------------------
let screenDirty = true;
let screenPts: Float64Array = new Float64Array(0); // [x0,y0,x1,y1,...] visible と同じ並び

function refreshScreenPts() {
  if (!screenDirty) return;
  screenPts = new Float64Array(located.length * 2);
  for (let i = 0; i < located.length; i++) {
    const p = map.project([located[i].lon!, located[i].lat!]);
    screenPts[i * 2] = p.x;
    screenPts[i * 2 + 1] = p.y;
  }
  screenDirty = false;
}

/** 画面座標に一番近い軌跡の線分を探し、その線分の近い方の端の写真を返す。動画モードでは紫の点との距離で探す */
function nearestOnTrack(pt: { x: number; y: number }, radius: number): MediaItem | null {
  refreshScreenPts();
  let best: MediaItem | null = null;
  let bestD = radius * radius;
  if (currentKind === "video" || favOnly || map.getZoom() >= DOT_ZOOM) {
    for (const it of visible) {
      const dx = screenPts[it.li * 2] - pt.x, dy = screenPts[it.li * 2 + 1] - pt.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }
  for (const seg of segments) {
    for (let k = 1; k < seg.length; k++) {
      const a = seg[k - 1], b = seg[k];
      const ax = screenPts[a.li * 2], ay = screenPts[a.li * 2 + 1], bx = screenPts[b.li * 2], by = screenPts[b.li * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2));
      const px = ax + t * dx - pt.x, py = ay + t * dy - pt.y;
      const d = px * px + py * py;
      if (d < bestD) { bestD = d; best = t < 0.5 ? a : b; }
    }
  }
  return best && toVisible(best);
}

/** 軌跡上の点(located)を、種類フィルター後の一番時刻が近い項目に寄せる */
function toVisible(item: MediaItem): MediaItem | null {
  if (visible.length === 0) return null;
  const passes = (currentKind === "all" || item.type === currentKind) && (!favOnly || favs.has(item.id));
  if (passes) return item;
  const t = Date.parse(item.time!);
  let lo = 0, hi = visible.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(visible[mid].time!) < t) lo = mid + 1; else hi = mid;
  }
  const a = visible[lo - 1], b = visible[lo];
  if (!a) return b;
  return Math.abs(Date.parse(a.time!) - t) <= Math.abs(Date.parse(b.time!) - t) ? a : b;
}

// ---- レイヤーとイベント --------------------------------------------------------
map.on("load", async () => {
  const res = await fetch("/data/media.json");
  all = ((await res.json()) as { items: MediaItem[] }).items.filter((it) => !it.hidden);
  const perDay = new Map<string, number>();
  for (const it of all) if (it.day && it.lat !== null) perDay.set(it.day, (perDay.get(it.day) ?? 0) + 1);
  all = all.filter((it) => it.day && (perDay.get(it.day) ?? 0) >= MIN_DAY_ITEMS);

  map.addSource("track", { type: "geojson", data: trackGeoJSON([]) });
  map.addSource("days", { type: "geojson", data: daysGeoJSON([]) });
  map.addSource("cursor", { type: "geojson", data: pointGeoJSON(null) });
  map.addSource("hover", { type: "geojson", data: pointGeoJSON(null) });
  map.addSource("videos", { type: "geojson", data: pointsGeoJSON([]) });
  map.addSource("photos", { type: "geojson", data: pointsGeoJSON([]) });
  map.addSource("favs", { type: "geojson", data: pointsGeoJSON([]) });
  map.addSource("rivers", { type: "geojson", data: "/data/rivers.json", attribution: RIVER_ATTR });

  // 通った川(山谷川・猿ヶ石川・北上川・旧北上川)。地図タイルの上、軌跡の下
  map.addLayer({
    id: "rivers", type: "line", source: "rivers",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": COLORS.water, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 11, 5, 15, 12], "line-opacity": 0.85 },
  });

  map.addLayer({
    id: "track-casing", type: "line", source: "track", maxzoom: DOT_ZOOM,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 9], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "track", type: "line", source: "track", maxzoom: DOT_ZOOM,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": COLORS.track, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 5], "line-opacity": 0.9 },
  });
  // 拡大時: 写真 1 枚ずつを赤い小さな点で(線では繋がない)
  map.addLayer({
    id: "photo-dots", type: "circle", source: "photos", minzoom: DOT_ZOOM,
    paint: {
      "circle-color": COLORS.track, "circle-radius": ["interpolate", ["linear"], ["zoom"], DOT_ZOOM, 3, 18, 6],
      "circle-stroke-width": 1, "circle-stroke-color": "#ffffff", "circle-opacity": 0.9,
    },
  });
  // 動画を撮った場所は紫の点(写真は赤い軌跡そのもの)
  map.addLayer({
    id: "video-dots", type: "circle", source: "videos",
    paint: {
      "circle-color": COLORS.video, "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 6],
      "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff",
    },
  });
  // お気に入りは金色の点(常に表示)
  map.addLayer({
    id: "fav-dots", type: "circle", source: "favs",
    paint: {
      "circle-color": COLORS.fav, "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 7],
      "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "day-labels", type: "symbol", source: "days",
    layout: { "text-field": ["get", "label"], "text-font": ["Open Sans Bold"], "text-size": 12, "text-offset": [0.9, 0], "text-anchor": "left" },
    paint: { "text-color": COLORS.river, "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
  });
  map.addLayer({
    id: "hover-dot", type: "circle", source: "hover",
    paint: { "circle-color": "#ffffff", "circle-radius": 5, "circle-stroke-width": 2, "circle-stroke-color": COLORS.river },
  });
  map.addLayer({
    id: "cursor", type: "circle", source: "cursor",
    paint: { "circle-color": COLORS.track, "circle-radius": 8, "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
  });

  buildFilters();
  applyFilter();
  fitTo(visible);

  const canHover = window.matchMedia("(hover: hover)").matches;
  map.on("mousemove", (e) => {
    if (!canHover) return;
    const near = nearestOnTrack(e.point, HOVER_RADIUS);
    map.getCanvas().style.cursor = near ? "pointer" : "";
    if (near) hoverShow(near, e.originalEvent); else hoverHide();
  });
  map.on("click", (e) => {
    hoverHide();
    const near = nearestOnTrack(e.point, TAP_RADIUS);
    if (near) setCurrent(near, false);
    else if (view() !== "map") setView("map"); // 写真のない所をタップしたら閉じる
  });
  map.on("movestart", hoverHide);
  map.getCanvas().addEventListener("mouseleave", hoverHide);
  map.on("move", () => { screenDirty = true; });
  map.on("resize", () => { screenDirty = true; });
});

// ---- UI --------------------------------------------------------------------
$("#btn-fit").addEventListener("click", () => fitTo(visible));
$("#btn-layer").addEventListener("click", (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", String(on));
  map.setLayoutProperty("photo", "visibility", on ? "visible" : "none");
});
// 写真タップでフルスクリーン、× で 1 段階戻る(photo → split → map)
$("#photo-img").addEventListener("click", () => { if (view() === "split") setView("photo"); });
photoVideo.addEventListener("dblclick", () => { if (view() === "split") setView("photo"); });
$("#btn-close").addEventListener("click", () => setView(view() === "photo" ? "split" : "map"));
$("#btn-fav").addEventListener("click", () => {
  if (!current) return;
  if (favs.has(current.id)) favs.delete(current.id); else favs.add(current.id);
  storeFavs();
  $("#btn-fav").setAttribute("aria-pressed", String(favs.has(current.id)));
  (map.getSource("favs") as GeoJSONSource).setData(pointsGeoJSON(located.filter((i) => favs.has(i.id))));
  updateFilterLabels();
  if (favOnly) { const keep = current; applyFilter(); reselectAfterFilter(keep); }
});
$("#btn-prev").addEventListener("click", () => step(-1));
$("#btn-next").addEventListener("click", () => step(1));
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
  else if (e.key === "Escape" && view() !== "map") setView(view() === "photo" ? "split" : "map");
  else if (e.key === " " && !photoVideo.hidden) { e.preventDefault(); if (photoVideo.paused) photoVideo.play(); else photoVideo.pause(); }
});

// 写真の左右スワイプで前後(タッチのみ)。60px 以上横に動かして離したら隣へ。画像は動かさない(アニメーション無し)
{
  const el = $("#photo");
  let id = -1, sx = 0, sy = 0, dx = 0, horizontal: boolean | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || (e.target as HTMLElement).closest("button, #video-bar")) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; horizontal = null;
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horizontal = Math.abs(dx) > Math.abs(dy);
    if (horizontal) { try { el.setPointerCapture(id); } catch { /* 合成イベントなどで取れなければ無視 */ } }
  });
  const end = () => {
    if (id === -1) return;
    const go = horizontal && Math.abs(dx) > 60 ? (dx < 0 ? 1 : -1) : 0;
    id = -1;
    if (go) step(go);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => { id = -1; }); // 中断(OS のジェスチャ等)は切り替えない
}
