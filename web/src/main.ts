import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

/*
 * 設計
 *  - 画面を上下に二分。上 = 写真、下 = 地図。地図には軌跡(赤線)と日付ラベルだけを描き、写真のピンは置かない。
 *  - 軌跡の上をマウスでなぞる(PC)/タップする(スマホ)と、その場所で撮った写真が上に出る。軌跡上には青い点。
 *  - 前後ボタン・矢印キー・写真の左右スワイプで時刻順に移動。写真が地図の外に出たら地図が追う。
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
  vi: number; // visible 内の添字(フィルタごとに振り直す)
};

const MEDIA_BASE = (import.meta.env.VITE_MEDIA_BASE as string | undefined) ?? "/media";
const GSI = "https://cyberjapandata.gsi.go.jp/xyz";
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const TRACK_GAP_MS = 60 * 60 * 1000;
const MIN_DAY_ITEMS = 10; // これより少ない日(8/4 の 2 枚、7/31 の前日分など)は扱わない
// 軌跡を切る条件: 1 km 以上を 100 km/h 超で移動した区間(= GPS の瞬間移動)。車での移動は残す
const JUMP_KM = 1.0;
const JUMP_KMH = 100;
const HOVER_RADIUS = 14; // px。線からこの距離以内でなぞりに反応
const TAP_RADIUS = 28; // px。タップ用に広め
const FULL_DELAY_MS = 180; // なぞっている間はサムネイル、止まったら大きい画像に差し替えるまでの時間
const COLORS = { river: "#2a6f97", track: "#d93e2c" };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let all: MediaItem[] = [];
let visible: MediaItem[] = []; // 位置あり・日付フィルタ後・時刻順
let segments: MediaItem[][] = []; // 軌跡の区間
let currentDay: string | null = null;
let current: MediaItem | null = null;

// ---- 地図 ------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    glyphs: "/fonts/{fontstack}/{range}.pbf", // 日付ラベル用。0-255 の範囲だけ同梱
    sources: {
      pale: { type: "raster", tiles: [`${GSI}/pale/{z}/{x}/{y}.png`], tileSize: 256, minzoom: 5, maxzoom: 18, attribution: ATTR },
      photo: { type: "raster", tiles: [`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`], tileSize: 256, minzoom: 14, maxzoom: 18, attribution: ATTR },
    },
    layers: [
      { id: "pale", type: "raster", source: "pale", paint: { "raster-saturation": -1, "raster-contrast": -0.15, "raster-opacity": 0.9 } },
      { id: "photo", type: "raster", source: "photo", layout: { visibility: "none" }, minzoom: 13 },
    ],
  },
  center: [141.3, 38.95],
  zoom: 8,
  maxZoom: 18,
  attributionControl: false,
});
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
      const dtH = (Date.parse(it.time) - Date.parse(prev.time!)) / 3_600_000;
      const km = distanceKm(prev, it);
      const jump = km >= JUMP_KM && (dtH === 0 || km / dtH > JUMP_KMH);
      if (dtH * 3_600_000 > TRACK_GAP_MS || jump) {
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

function pointGeoJSON(item: MediaItem | null): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: item ? [{ type: "Feature", geometry: { type: "Point", coordinates: [item.lon!, item.lat!] }, properties: {} }] : [] };
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

// ---- 表示状態 ---------------------------------------------------------------
function applyFilter() {
  visible = all.filter((it) => it.lat !== null && (currentDay === null || it.day === currentDay));
  visible.forEach((it, i) => (it.vi = i));
  segments = trackSegments(visible);
  (map.getSource("track") as GeoJSONSource).setData(trackGeoJSON(segments));
  (map.getSource("days") as GeoJSONSource).setData(daysGeoJSON(visible));
  screenDirty = true;
  const photos = visible.filter((i) => i.type === "photo").length;
  $("#count").textContent = `写真 ${photos} 枚・動画 ${visible.length - photos} 本`;
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
let fullTimer: number | undefined;

/** 写真を上半分に出す。follow=true なら地図の外にあるとき地図を寄せる */
function setCurrent(item: MediaItem, follow: boolean) {
  const changed = current !== item;
  current = item;
  if (changed) {
    // なぞっている最中はサムネイル(軽い)。少し止まったら大きい画像に差し替える
    photoImg.src = `${MEDIA_BASE}/thumb/${item.id}.jpg`;
    photoImg.alt = fmtTime(item.time);
    window.clearTimeout(fullTimer);
    fullTimer = window.setTimeout(() => {
      const full = new Image();
      full.onload = () => { if (current === item) photoImg.src = full.src; };
      full.src = `${MEDIA_BASE}/web/${item.id}.jpg`;
    }, FULL_DELAY_MS);
    $("#photo-time").textContent = fmtTime(item.time);
    const parts = [`${item.vi + 1} / ${visible.length}`];
    if (item.type === "video") parts.push(`動画 ${item.duration ?? "?"} 秒(再生は後日対応)`);
    if (item.gps !== "exif") parts.push("位置は前後の写真から推定");
    $("#photo-sub").textContent = parts.join("・");
    $("#photo-camera").textContent = cameraName(item);
    ($("#btn-prev") as HTMLButtonElement).disabled = item.vi === 0;
    ($("#btn-next") as HTMLButtonElement).disabled = item.vi === visible.length - 1;
    (map.getSource("cursor") as GeoJSONSource).setData(pointGeoJSON(item));
    updateScrub(item);
  }
  if (follow) {
    const p = map.project([item.lon!, item.lat!]);
    const c = map.getContainer();
    const inside = p.x > 40 && p.x < c.clientWidth - 40 && p.y > 48 && p.y < c.clientHeight - 40;
    if (!inside) map.easeTo({ center: [item.lon!, item.lat!], duration: 400 });
  }
}

function step(delta: number) {
  const base = current ?? visible[0];
  if (!base) return;
  const next = visible[(current ? base.vi : -1) + delta] ?? (current ? undefined : visible[0]);
  if (next) setCurrent(next, true);
}

function buildDayChips() {
  const days = [...new Set(all.map((i) => i.day).filter((d): d is string => !!d))].sort();
  const wrap = $("#days");
  const mk = (label: string, day: string | null) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(day === currentDay));
    b.addEventListener("click", () => {
      currentDay = day;
      wrap.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      applyFilter();
      fitTo(visible);
      current = null; // 絞り込みで枚数・添字が変わるので、同じ写真でも表示を作り直す
      if (visible[0]) setCurrent(visible[0], false);
    });
    return b;
  };
  wrap.appendChild(mk("全日", null));
  for (const d of days) wrap.appendChild(mk(dayLabel(d), d));
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
  screenPts = new Float64Array(visible.length * 2);
  for (let i = 0; i < visible.length; i++) {
    const p = map.project([visible[i].lon!, visible[i].lat!]);
    screenPts[i * 2] = p.x;
    screenPts[i * 2 + 1] = p.y;
  }
  screenDirty = false;
}

/** 画面座標に一番近い軌跡の線分を探し、その線分の近い方の端の写真を返す */
function nearestOnTrack(pt: { x: number; y: number }, radius: number): MediaItem | null {
  refreshScreenPts();
  let best: MediaItem | null = null;
  let bestD = radius * radius;
  for (const seg of segments) {
    for (let k = 1; k < seg.length; k++) {
      const a = seg[k - 1], b = seg[k];
      const ax = screenPts[a.vi * 2], ay = screenPts[a.vi * 2 + 1], bx = screenPts[b.vi * 2], by = screenPts[b.vi * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2));
      const px = ax + t * dx - pt.x, py = ay + t * dy - pt.y;
      const d = px * px + py * py;
      if (d < bestD) { bestD = d; best = t < 0.5 ? a : b; }
    }
  }
  return best;
}

// ---- レイヤーとイベント --------------------------------------------------------
map.on("load", async () => {
  const res = await fetch("/data/media.json");
  all = ((await res.json()) as { items: MediaItem[] }).items;
  const perDay = new Map<string, number>();
  for (const it of all) if (it.day && it.lat !== null) perDay.set(it.day, (perDay.get(it.day) ?? 0) + 1);
  all = all.filter((it) => it.day && (perDay.get(it.day) ?? 0) >= MIN_DAY_ITEMS);

  map.addSource("track", { type: "geojson", data: trackGeoJSON([]) });
  map.addSource("days", { type: "geojson", data: daysGeoJSON([]) });
  map.addSource("cursor", { type: "geojson", data: pointGeoJSON(null) });

  map.addLayer({
    id: "track-casing", type: "line", source: "track",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 9], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "track", type: "line", source: "track",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": COLORS.track, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 5], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "day-labels", type: "symbol", source: "days",
    layout: { "text-field": ["get", "label"], "text-font": ["Open Sans Bold"], "text-size": 12, "text-offset": [0.9, 0], "text-anchor": "left" },
    paint: { "text-color": COLORS.river, "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
  });
  map.addLayer({
    id: "cursor", type: "circle", source: "cursor",
    paint: { "circle-color": COLORS.river, "circle-radius": 8, "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" },
  });

  buildDayChips();
  applyFilter();
  fitTo(visible);
  if (visible[0]) setCurrent(visible[0], false);

  const canHover = window.matchMedia("(hover: hover)").matches;
  map.on("mousemove", (e) => {
    if (!canHover) return;
    const near = nearestOnTrack(e.point, HOVER_RADIUS);
    map.getCanvas().style.cursor = near ? "crosshair" : "";
    if (near) setCurrent(near, false);
  });
  map.on("click", (e) => {
    const near = nearestOnTrack(e.point, TAP_RADIUS);
    if (near) setCurrent(near, false);
  });
  map.on("move", () => { screenDirty = true; });
});

// ---- UI --------------------------------------------------------------------
$("#btn-fit").addEventListener("click", () => fitTo(visible));
$("#btn-layer").addEventListener("click", (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", String(on));
  map.setLayoutProperty("photo", "visibility", on ? "visible" : "none");
});
$("#btn-prev").addEventListener("click", () => step(-1));
$("#btn-next").addEventListener("click", () => step(1));
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
});

// 写真の左右スワイプで前後
{
  let sx = 0, sy = 0, active = false;
  const el = $("#photo");
  el.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true; }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (!active) return;
    active = false;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });
}
