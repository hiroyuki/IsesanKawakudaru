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
- 撮影時刻はすべて JST に揃える。写真の EXIF `DateTimeOriginal` は JST。動画はカメラごとに違う: iPhone は `com.apple.quicktime.creationdate`(+0900 付き)を使う。Canon XC10(MVI_)と GoPro は `creation_time` が Z 付きでも実体は JST。それ以外(UUID 名の .mov など)は本当に UTC なので +9h。
- GPS のない素材(Canon XC10、動画)は前後 2 時間以内の GPS 付き写真から時刻補完する(`gps: "interp" | "nearest"`)。2 時間以内に無ければ同じ日の一番近い写真の位置を使う(日はまたがない)。写真の説明に「位置は前後の写真から推定」と出す。
- 地図には写真のピンを置かない。軌跡(赤線)だけを描き、軌跡をなぞる/タップすると上半分にその場所の写真が出る(ユーザー決定)。ズーム 14 以上では 1 件ずつ点で出し、画面上で重なる点(同じ座標に積み重なった推定位置の動画など)は本来の位置を中心にリング状に時刻順で広げる(main.ts の spreadOverlaps)。
- 位置付きの写真が 10 枚未満の日(8/4、7/31)は表示しない。3 秒以下の動画も出さない(build_media.py の MIN_VIDEO_SEC)。連続する写真の間が 1km 以上離れている区間は軌跡の線を引かない(速度は見ない)。
- 地図はモノトーン(`raster-saturation: -1`)。
- `web/public/data/media.json` は `scripts/build_media.py` の生成物。手で編集しない。
- 日本語 UI。地理院タイルと国土数値情報(河川データ)の出典表示(リンク付き)を必ず残す。
- お気に入りは今のところ端末ごと(localStorage)。コメント機能のログイン実装後に共有化を検討。
- 写真・動画ごとの URL は `/p/<id>`。選択時に history.replaceState で反映し、起動時にその id を開く。

## ファイル構成

```
CLAUDE_BASICS/            共通ルール・スキル(submodule)
.claude/skills/           CLAUDE_BASICS/skills への symlink
scripts/build_media.py    素材 → media.json + サムネイル(400px)/閲覧用(1600px)/動画 720p 生成。data/exclude.json の id に hidden を付ける
data/exclude.json         選別で除外した素材の id(web/curate.html で編集)。コミットする
scripts/build_rivers.py   国土数値情報 河川データ(W05)から山谷川・猿ヶ石川・北上川・旧北上川を web/public/data/rivers.json に切り出す
web/                      Vite + TypeScript + MapLibre GL JS(静的サイト、Cloudflare Pages 配信予定)
  public/data/media.json  全素材のメタデータ(生成物、コミットする)
  public/data/rivers.json 通った川の中心線 GeoJSON(生成物、コミットする。出典: 国土数値情報(河川データ))
  public/fonts/           地図ラベル用グリフ(Open Sans Bold の 0-255 だけ)
  src/main.ts             上半分=写真 / 下半分=地図。軌跡・日付ラベル・なぞり/タップで写真切替・前後送り・日付フィルタ
  src/style.css           上下二分のスマホ優先レイアウト
  curate.html, src/curate.ts  開発専用の選別ページ(http://localhost:5173/curate.html)。本番ビルドには含めない
  functions/p/[id].js     Pages Function。/p/<id> で写真ごとの OG 情報(タイトル・画像)を index.html に差し込んで返す
  public/og.jpg           サイト全体の OG 画像(1200×630、8/6 北上川のカヤック)
  vite.config.ts          開発時 /media を localhost:8788(npm run media)へプロキシ。/p/<id> は SPA フォールバックで index.html
  .env.development        VITE_MEDIA_BASE=/media(本番は .env.production で R2 の URL)
media/ (git 外)           thumb/ web/ の縮小画像と video/ の 720p mp4。本番は Cloudflare R2 に置く
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

## デプロイ(Cloudflare、個人アカウント hori@p4n.jp / account_id は web/wrangler.toml)

- サイト + 写真(thumb/ web/): Cloudflare Pages プロジェクト `kawakudari` → https://kawakudari.pages.dev/ 。`scripts/deploy.sh` がビルドして `dist/media` に写真をコピーしてデプロイする(hidden は除く)。
- 動画: R2 バケット `kawakudari-media`(公開 URL https://pub-dae6c5ccd89d4ee08dc0e6cbfb5d3724.r2.dev)。`scripts/upload_videos.sh` で `video/<id>.mp4` を上げる。25MB 超の動画があるため Pages には置けない。
- wrangler は v3 を `npx wrangler@3` で使う(v4 は Node 22 が必要で、この Mac は Node 20)。
- `web/.env.production` の VITE_VIDEO_BASE が R2 の URL。VITE_MEDIA_BASE は `/media`(Pages 同一オリジン)。

## 予定(未実装)

- コメント機能: Cloudflare Pages Functions + D1、合言葉ログイン(投稿できるのはイセさんのみ)。写真に紐づくコメントと場所だけのコメント。
- 動画は media/video/<id>.mp4(720p)を <video> で直接再生する(YouTube は使わない方針に変更の余地あり)。
