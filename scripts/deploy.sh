#!/usr/bin/env bash
# サイトを Cloudflare Pages にデプロイする。
#   1. web をビルド(.env.production の VITE_VIDEO_BASE を使う)
#   2. 写真の縮小版(thumb/ web/)を dist/media にコピー(Pages の静的ファイルとして配信、各 25MB 未満)
#   3. wrangler pages deploy
# 動画は scripts/upload_videos.sh で R2 に上げる(25MB 超があるため Pages には置けない)。
# 使い方: scripts/deploy.sh [--media /path/to/media] [--project kawakudari]
set -euo pipefail
cd "$(dirname "$0")/.."
MEDIA="${MEDIA:-$(cd .. && pwd)/media}"
PROJECT="${PROJECT:-kawakudari}"
while [ $# -gt 0 ]; do
  case "$1" in
    --media) MEDIA="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[ -d "$MEDIA/thumb" ] && [ -d "$MEDIA/web" ] || { echo "media not found: $MEDIA" >&2; exit 1; }
grep -q REPLACE_WITH web/.env.production && { echo "web/.env.production の VITE_VIDEO_BASE を R2 の公開 URL に書き換えてください" >&2; exit 1; }

(cd web && npm run build)
# 除外(hidden)した素材は配信しない
python3 - "$MEDIA" <<'PY'
import json, os, shutil, sys
media = sys.argv[1]
items = json.load(open("web/public/data/media.json"))["items"]
keep = {i["id"] for i in items if not i.get("hidden")}
for sub in ("thumb", "web"):
    dst = os.path.join("web/dist/media", sub)
    os.makedirs(dst, exist_ok=True)
    n = 0
    for f in os.listdir(os.path.join(media, sub)):
        if f[:-4] in keep:
            shutil.copy2(os.path.join(media, sub, f), os.path.join(dst, f))
            n += 1
    print(f"{sub}: {n} files")
PY
(cd web && npx --yes wrangler@3 pages deploy dist --project-name "$PROJECT" --commit-dirty=true)
