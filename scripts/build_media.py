#!/usr/bin/env python3
"""素材フォルダから media.json と Web 用縮小画像を生成する。

使い方:
  uv run --with pillow scripts/build_media.py --src "/path/2017川下りALL" --media /path/media --json web/public/data/media.json
  （--no-thumbs でメタデータだけ更新）

出力:
  media.json      全写真・動画のメタデータ(時刻 JST、位置、補完フラグ、カメラ、サイズ)
  media/thumb/    長辺 400px のサムネイル (JPEG)
  media/web/      長辺 1600px の閲覧用 (JPEG)
  media/video/    動画の Web 再生用 (H.264 720p MP4、約 2.5Mbps)
  動画はポスターフレーム(1 秒目)を同じ 2 サイズで書き出す。
"""
from __future__ import annotations

import argparse
import json
import re
import math
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone

from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS, TAGS

JST = timezone(timedelta(hours=9))
PHOTO_EXT = {".jpg", ".jpeg"}
VIDEO_EXT = {".mp4", ".mov"}
THUMB_PX = 400
WEB_PX = 1600
MIN_VIDEO_SEC = 3.0  # これ以下の長さの動画は出さない(hidden)。ユーザー指定
VIDEO_HEIGHT = 720
VIDEO_KBPS = 2500
BBOX = (38.0, 140.5, 40.0, 142.0)  # lat0, lon0, lat1, lon1  (遠野〜石巻の外は外れ値扱い)
SPIKE_KM = 0.5  # 前後の両方からこれ以上離れた場所へ飛んで戻る点は GPS スパイクとして捨てる
SPIKE_MAX_RUN = 3  # 連続して飛んでいる点をまとめて捨てる最大数
SPIKE_MAX_SPAN = timedelta(minutes=10)  # 飛んで戻るまでの最大時間
INTERP_MAX = timedelta(hours=2)  # これより離れた GPS 写真とは補間しない。超えても同じ日なら一番近い写真の位置を使う(日はまたがない)


def media_id(name: str) -> str:
    return name.lower().replace(".", "_").replace("-", "_")


def dms(v) -> float:
    d, m, s = (float(x) for x in v)
    return d + m / 60 + s / 3600


def read_photo(path: str) -> dict:
    im = Image.open(path)
    ex = im.getexif()
    tags = {TAGS.get(k, k): v for k, v in ex.items()}
    sub = {TAGS.get(k, k): v for k, v in ex.get_ifd(0x8769).items()}
    gps = {GPSTAGS.get(k, k): v for k, v in ex.get_ifd(0x8825).items()}
    dto = sub.get("DateTimeOriginal") or tags.get("DateTime")
    t = datetime.strptime(dto, "%Y:%m:%d %H:%M:%S").replace(tzinfo=JST) if dto else None
    lat = lon = None
    if "GPSLatitude" in gps and "GPSLongitude" in gps:
        lat = dms(gps["GPSLatitude"]) * (-1 if gps.get("GPSLatitudeRef") == "S" else 1)
        lon = dms(gps["GPSLongitude"]) * (-1 if gps.get("GPSLongitudeRef") == "W" else 1)
    orient = tags.get("Orientation", 1)
    w, h = im.size
    if orient in (5, 6, 7, 8):
        w, h = h, w
    return {"type": "photo", "time": t, "lat": lat, "lon": lon,
            "camera": str(tags.get("Model") or "").replace("\x00", "").strip(), "w": w, "h": h}


def ffprobe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def read_video(path: str) -> dict:
    info = ffprobe(path)
    fmt = info["format"]
    vs = next((s for s in info["streams"] if s.get("codec_type") == "video"), {})
    tags = fmt.get("tags", {})
    t = None
    # 時刻の扱いはカメラごとに違う:
    #  - iPhone: com.apple.quicktime.creationdate にオフセット付き(+0900)の現地時刻がある → それを使う
    #  - Canon XC10 (MVI_) / GoPro (GOPR, Gnnnnnnn): creation_time は Z 付きだが実体は現地時刻(JST)
    #  - それ以外(UUID 名の .mov など、iPhone から書き出したもの): creation_time は本当に UTC → +9h
    cd = tags.get("com.apple.quicktime.creationdate")
    ct = tags.get("creation_time") or vs.get("tags", {}).get("creation_time")
    name = os.path.basename(path).upper()
    if cd:
        t = datetime.strptime(cd[:24], "%Y-%m-%dT%H:%M:%S%z").astimezone(JST)
    elif ct:
        naive = datetime.strptime(ct[:19], "%Y-%m-%dT%H:%M:%S")
        if name.startswith("MVI_") or name.startswith("GOPR") or re.match(r"^G\d{7}\.", name):
            t = naive.replace(tzinfo=JST)
        else:
            t = naive.replace(tzinfo=timezone.utc).astimezone(JST)
    w, h = int(vs.get("width", 0)), int(vs.get("height", 0))
    rot = 0
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if rot % 180 == 90:
        w, h = h, w
    model = (fmt.get("tags", {}).get("com.apple.quicktime.model")
             or fmt.get("tags", {}).get("model") or "")
    return {"type": "video", "time": t, "lat": None, "lon": None, "camera": model.strip(),
            "w": w, "h": h, "duration": round(float(fmt.get("duration", 0)), 1)}


def haversine_km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def kmh(a, b) -> float:
    dt = (b["time"] - a["time"]).total_seconds()
    if dt <= 0:
        return 0.0
    return haversine_km((a["lat"], a["lon"]), (b["lat"], b["lon"])) / (dt / 3600)


def clean_gps(items: list[dict]) -> int:
    """bbox 外とスパイクの GPS を捨てる。捨てた数を返す。"""
    dropped = 0
    for it in items:
        if it["lat"] is None:
            continue
        if not (BBOX[0] <= it["lat"] <= BBOX[2] and BBOX[1] <= it["lon"] <= BBOX[3]):
            it["lat"] = it["lon"] = None
            it["gps_dropped"] = "bbox"
            dropped += 1
    fixed = [it for it in items if it["lat"] is not None and it["time"]]
    fixed.sort(key=lambda x: x["time"])
    # スパイク = 1〜3 点が前後から SPIKE_KM 以上離れた場所へ行ってすぐ戻る形(前と後ろ同士は近い)。
    # 車で移動した区間は前→後ろも離れているので残る。判定は元座標のスナップショットで行う。
    snap = [(f["lat"], f["lon"], f["time"]) for f in fixed]
    i = 1
    while i < len(snap) - 1:
        p = snap[i - 1]
        hit = 0
        for run in range(1, SPIKE_MAX_RUN + 1):
            j = i + run  # 戻ってくる点
            if j >= len(snap):
                break
            n = snap[j]
            if (n[2] - p[2]) > SPIKE_MAX_SPAN:
                break
            direct = haversine_km(p[:2], n[:2])
            if direct > SPIKE_KM:
                continue
            if all(haversine_km(p[:2], snap[k][:2]) > SPIKE_KM and haversine_km(n[:2], snap[k][:2]) > SPIKE_KM for k in range(i, j)):
                hit = run
                break
        if hit:
            for k in range(i, i + hit):
                fixed[k]["lat"] = fixed[k]["lon"] = None
                fixed[k]["gps_dropped"] = "spike"
                dropped += 1
            i += hit
        i += 1
    return dropped


def interpolate(items: list[dict]) -> int:
    """GPS のない項目に、時刻の近い GPS 項目から位置を補完する。補完した数を返す。"""
    fixed = sorted((it for it in items if it["lat"] is not None and it["time"]), key=lambda x: x["time"])
    times = [f["time"] for f in fixed]
    n = 0
    for it in items:
        if it["lat"] is not None or not it["time"]:
            continue
        # 二分探索
        lo, hi = 0, len(times)
        while lo < hi:
            mid = (lo + hi) // 2
            if times[mid] < it["time"]:
                lo = mid + 1
            else:
                hi = mid
        prev_fix = fixed[lo - 1] if lo > 0 else None
        next_fix = fixed[lo] if lo < len(fixed) else None
        before = prev_fix if prev_fix and (it["time"] - prev_fix["time"]) <= INTERP_MAX else None
        after = next_fix if next_fix and (next_fix["time"] - it["time"]) <= INTERP_MAX else None
        if not before and not after:
            # 2 時間以内に無ければ、同じ日の一番近い GPS 写真を使う(キャンプ地で夕方に撮った動画など)
            same_day = [f for f in (prev_fix, next_fix) if f and f["time"].date() == it["time"].date()]
            if same_day:
                before = min(same_day, key=lambda f: abs((f["time"] - it["time"]).total_seconds()))
        if before and after:
            span = (after["time"] - before["time"]).total_seconds()
            f = 0.5 if span == 0 else (it["time"] - before["time"]).total_seconds() / span
            it["lat"] = before["lat"] + (after["lat"] - before["lat"]) * f
            it["lon"] = before["lon"] + (after["lon"] - before["lon"]) * f
            it["gps"] = "interp"
        elif before or after:
            src = before or after
            it["lat"], it["lon"], it["gps"] = src["lat"], src["lon"], "nearest"
        else:
            continue
        n += 1
    return n


def make_images(job: tuple[str, str, str, str]) -> str | None:
    src, kind, thumb_path, web_path = job
    if os.path.exists(thumb_path) and os.path.exists(web_path):
        return None
    try:
        if kind == "video":
            tmp = thumb_path + ".frame.jpg"
            # 1 秒目を取る。1 秒未満の動画などで取れなければ先頭フレーム。
            for ss in ("1", "0"):
                subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-ss", ss, "-i", src, "-frames:v", "1", "-q:v", "3", tmp])
                if os.path.exists(tmp):
                    break
            im = Image.open(tmp)
            im.load()
            os.remove(tmp)
        else:
            im = ImageOps.exif_transpose(Image.open(src))
        im = im.convert("RGB")
        for px, out, q in ((WEB_PX, web_path, 82), (THUMB_PX, thumb_path, 80)):
            c = im.copy()
            c.thumbnail((px, px), Image.LANCZOS)
            c.save(out, "JPEG", quality=q, optimize=True, progressive=True)
        return None
    except Exception as e:  # noqa: BLE001
        return f"{src}: {e}"


def make_video(job: tuple[str, str]) -> str | None:
    """Web 再生用に 720p H.264 へ変換(Mac の VideoToolbox を使う。無ければ libx264)。"""
    src, out = job
    if os.path.exists(out):
        return None
    tmp = out + ".part.mp4"
    base = ["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", f"scale=-2:'min({VIDEO_HEIGHT},ih)'",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-pix_fmt", "yuv420p"]
    for venc in (["-c:v", "h264_videotoolbox", "-b:v", f"{VIDEO_KBPS}k"], ["-c:v", "libx264", "-preset", "fast", "-crf", "23"]):
        r = subprocess.run(base + venc + [tmp], capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, out)
            return None
    return f"{src}: {r.stderr.strip()[-200:]}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--media", required=True)
    ap.add_argument("--json", required=True)
    ap.add_argument("--exclude", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "exclude.json"),
                    help="除外する id のリスト(web/curate.html で作る)。hidden: true を付ける")
    ap.add_argument("--no-thumbs", action="store_true")
    ap.add_argument("--no-video", action="store_true", help="動画の 720p 変換を省く")
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    a = ap.parse_args()

    items: list[dict] = []
    for name in sorted(os.listdir(a.src)):
        ext = os.path.splitext(name)[1].lower()
        path = os.path.join(a.src, name)
        try:
            if ext in PHOTO_EXT:
                it = read_photo(path)
            elif ext in VIDEO_EXT:
                it = read_video(path)
            else:
                continue
        except Exception as e:  # noqa: BLE001
            print(f"skip {name}: {e}", file=sys.stderr)
            continue
        it["id"] = media_id(name)
        it["file"] = name
        it["gps"] = "exif" if it["lat"] is not None else None
        items.append(it)

    excluded: set[str] = set()
    if os.path.exists(a.exclude):
        with open(a.exclude) as f:
            excluded = set(json.load(f).get("ids", []))

    dropped = clean_gps(items)
    interp = interpolate(items)
    items.sort(key=lambda x: (x["time"] or datetime.max.replace(tzinfo=JST), x["file"]))

    out = []
    for it in items:
        rec = {
            "id": it["id"], "file": it["file"], "type": it["type"],
            "time": it["time"].isoformat() if it["time"] else None,
            "day": it["time"].strftime("%Y-%m-%d") if it["time"] else None,
            "lat": round(it["lat"], 6) if it["lat"] is not None else None,
            "lon": round(it["lon"], 6) if it["lon"] is not None else None,
            "gps": it["gps"], "camera": it["camera"], "w": it["w"], "h": it["h"],
        }
        if it["type"] == "video":
            rec["duration"] = it["duration"]
        if it.get("gps_dropped"):
            rec["gps_dropped"] = it["gps_dropped"]
        if it["id"] in excluded or (it["type"] == "video" and it["duration"] <= MIN_VIDEO_SEC):
            rec["hidden"] = True  # 選別で除外、または 3 秒以下の動画(サイトに出さない・R2 に上げない)。ファイルは残す
        out.append(rec)

    os.makedirs(os.path.dirname(a.json), exist_ok=True)
    with open(a.json, "w") as f:
        json.dump({"generated": datetime.now(JST).isoformat(timespec="seconds"), "items": out}, f, ensure_ascii=False, separators=(",", ":"))
    located = sum(1 for r in out if r["lat"] is not None)
    print(f"hidden={sum(1 for r in out if r.get('hidden'))} "
          f"items={len(out)} photos={sum(1 for r in out if r['type']=='photo')} videos={sum(1 for r in out if r['type']=='video')} "
          f"located={located} interpolated={interp} dropped_gps={dropped} no_position={len(out)-located}")

    # 除外した素材も生成物は作る(選別ページで見直せるように)。除外は hidden フラグ(サイト)と R2 への転送時に効かせる

    if a.no_thumbs:
        return
    tdir, wdir = os.path.join(a.media, "thumb"), os.path.join(a.media, "web")
    os.makedirs(tdir, exist_ok=True)
    os.makedirs(wdir, exist_ok=True)
    jobs = [(os.path.join(a.src, it["file"]), it["type"],
             os.path.join(tdir, it["id"] + ".jpg"), os.path.join(wdir, it["id"] + ".jpg")) for it in items]
    errors = 0
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, err in enumerate(ex.map(make_images, jobs, chunksize=8), 1):
            if err:
                errors += 1
                print(err, file=sys.stderr)
            if i % 500 == 0:
                print(f"images {i}/{len(jobs)}", file=sys.stderr)
    print(f"images done, errors={errors}")

    if a.no_video:
        return
    vdir = os.path.join(a.media, "video")
    os.makedirs(vdir, exist_ok=True)
    vjobs = [(os.path.join(a.src, it["file"]), os.path.join(vdir, it["id"] + ".mp4")) for it in items if it["type"] == "video"]
    verrors = 0
    # ハードウェアエンコーダは同時実行数が少ないほうが速いので 2 並列
    with ProcessPoolExecutor(max_workers=2) as ex:
        for i, err in enumerate(ex.map(make_video, vjobs), 1):
            if err:
                verrors += 1
                print(err, file=sys.stderr)
            if i % 25 == 0:
                print(f"videos {i}/{len(vjobs)}", file=sys.stderr)
    print(f"videos done, errors={verrors}")


if __name__ == "__main__":
    main()
