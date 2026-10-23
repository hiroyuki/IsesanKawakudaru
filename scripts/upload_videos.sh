#!/usr/bin/env bash
# 720p 動画を Cloudflare R2 に上げる(除外した素材は上げない)。
# 使い方: scripts/upload_videos.sh [--media /path/to/media] [--bucket kawakudari-media]
# 事前: npx wrangler@3 r2 bucket create kawakudari-media && 公開 URL(r2.dev)を有効化
set -euo pipefail
cd "$(dirname "$0")/.."
MEDIA="${MEDIA:-$(cd .. && pwd)/media}"
BUCKET="${BUCKET:-kawakudari-media}"
while [ $# -gt 0 ]; do
  case "$1" in
    --media) MEDIA="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
python3 - "$MEDIA" "$BUCKET" <<'PY'
import json, os, subprocess, sys
media, bucket = sys.argv[1], sys.argv[2]
items = json.load(open("web/public/data/media.json"))["items"]
videos = [i["id"] for i in items if i["type"] == "video" and not i.get("hidden")]
done = 0
missing = []
for vid in videos:
    path = os.path.join(media, "video", vid + ".mp4")
    if not os.path.exists(path):
        missing.append(path); continue
    subprocess.run(["npx", "--yes", "wrangler@3", "r2", "object", "put", f"{bucket}/video/{vid}.mp4", "--file", path,
                    "--content-type", "video/mp4", "--cache-control", "public, max-age=31536000, immutable"], check=True,
                   stdout=subprocess.DEVNULL)
    done += 1
    if done % 20 == 0: print(f"{done}/{len(videos)}")
print(f"uploaded {done} videos")
if missing:
    print(f"ERROR: {len(missing)} videos missing (run build_media.py first):", *missing[:10], sep="\n  ")
    sys.exit(1)
PY
