# IsesanKawakudaru Claude 作業ルール

## 共通ルール

[CLAUDE_BASICS/claude_basics.md](./CLAUDE_BASICS/claude_basics.md) を参照。

## プロジェクト概要

2017 年 8 月、遠野市綾織の山谷川源流から猿ヶ石川・北上川を下って石巻の海に出た旅のアーカイブサイト。
写真 5,435 枚・動画 232 本を地図(地理院タイル)上に時刻・位置で並べ、伊勢崎克彦氏(イセさん)がコメントを残せるようにする。
純粋な思い出のアーカイブであり、選挙の応援メッセージは載せない。予算ゼロ(無料枠のみ)。閲覧者の 9 割はスマホ。

## プロジェクト固有ルール

- 素材フォルダ `2017川下りALL/` と生成物 `media/` は git 管理外。絶対に git add しない(14GB)。
- 地図は国土地理院の地理院タイルのみ使う。Google Maps / Mapbox は使わない(課金・カード登録が必要なため)。
- 撮影時刻はすべて JST。EXIF の `DateTimeOriginal` は JST、動画の `creation_time` も Z 付きだが実体は JST として扱う。
- GPS のない素材(Canon XC10、動画)は前後の GPS 付き写真から時刻補完する(`gps: "interp" | "nearest"`)。写真の説明に「位置は前後の写真から推定」と出す。
- 地図には写真のピンを置かない。軌跡(赤線)だけを描き、軌跡をなぞる/タップすると上半分にその場所の写真が出る(ユーザー決定)。
- 位置付きの写真が 10 枚未満の日(8/4、7/31)は表示しない。1km 以上を 100km/h 超で移動した区間は GPS の飛びとみなし軌跡を切る。
- 地図はモノトーン(`raster-saturation: -1`)。
- `web/public/data/media.json` は `scripts/build_media.py` の生成物。手で編集しない。
- 日本語 UI。地理院タイルの出典表示(リンク付き)を必ず残す。

## ファイル構成

```
CLAUDE_BASICS/            共通ルール・スキル(submodule)
.claude/skills/           CLAUDE_BASICS/skills への symlink
scripts/build_media.py    素材 → media.json + サムネイル(400px)/閲覧用(1600px) 生成
web/                      Vite + TypeScript + MapLibre GL JS(静的サイト、Cloudflare Pages 配信予定)
  public/data/media.json  全素材のメタデータ(生成物、コミットする)
  public/fonts/           地図ラベル用グリフ(Open Sans Bold の 0-255 だけ)
  src/main.ts             上半分=写真 / 下半分=地図。軌跡・日付ラベル・なぞり/タップで写真切替・前後送り・日付フィルタ
  src/style.css           上下二分のスマホ優先レイアウト
  vite.config.ts          開発時 /media を localhost:8788(npm run media)へプロキシ
  .env.development        VITE_MEDIA_BASE=/media(本番は .env.production で R2 の URL)
media/ (git 外)           thumb/ web/ の縮小画像。本番は Cloudflare R2 に置く
2017川下りALL/ (git 外)   元素材
```

## 開発手順

```bash
# 1. メタデータと縮小画像を生成(初回は数分)
uv run --with pillow scripts/build_media.py --src "$PWD/2017川下りALL" --media "$PWD/media" --json web/public/data/media.json

# 2. 縮小画像を配信(別ターミナル)
cd web && npm run media

# 3. 開発サーバー
cd web && npm install && npm run dev
```

worktree で作業する場合、`--src` と `--media` はメインリポジトリ側の絶対パスを指定する。

## 予定(未実装)

- コメント機能: Cloudflare Pages Functions + D1、合言葉ログイン(投稿できるのはイセさんのみ)。写真に紐づくコメントと場所だけのコメント。
- 動画再生: YouTube 限定公開に上げて ID を media.json に紐づける。
- デプロイ: Cloudflare Pages(サイト)+ R2(media/)。
