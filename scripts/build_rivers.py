#!/usr/bin/env python3
"""国土数値情報 河川データ(W05)から、川下りで通った川の中心線だけを GeoJSON に切り出す。

使い方:
  uv run --with pyshp scripts/build_rivers.py --src <W05 の zip を展開したフォルダ(複数可)> --out web/public/data/rivers.json

入力は国土交通省 国土数値情報 河川データ W05-07(2007 年度)の岩手県(03)・宮城県(04)。
  https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W05.html
出典表記: 「国土数値情報(河川データ)(国土交通省)」
"""
from __future__ import annotations

import argparse
import json
import os

import shapefile  # pyshp

# 通った川(上流から順)。北上川は柳津で分かれ、石巻へ出る方が旧北上川
RIVERS = ["山谷川", "猿ヶ石川", "北上川", "旧北上川"]
NAME_FIELD = "W05_004"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    features = []
    counts: dict[str, int] = {}
    for d in a.src:
        shp = next((os.path.join(d, f[:-4]) for f in os.listdir(d) if f.endswith("_Stream.shp")), None)
        if not shp:
            raise SystemExit(f"Stream.shp が見つかりません: {d}")
        r = shapefile.Reader(shp, encoding="cp932")
        idx = [f[0] for f in r.fields[1:]].index(NAME_FIELD)
        for sr in r.iterShapeRecords():
            name = sr.record[idx]
            if name not in RIVERS:
                continue
            # 山谷川は全国に同名の川があるので、遠野付近(綾織)のものだけ
            pts = sr.shape.points
            if name == "山谷川" and not any(141.3 < x < 141.6 and 39.2 < y < 39.5 for x, y in pts[:1]):
                continue
            parts = list(sr.shape.parts) + [len(pts)]
            for i in range(len(parts) - 1):
                seg = [[round(x, 5), round(y, 5)] for x, y in pts[parts[i]:parts[i + 1]]]
                if len(seg) > 1:
                    features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": seg}, "properties": {"name": name}})
            counts[name] = counts.get(name, 0) + 1

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"rivers: {counts} → {len(features)} lines, {os.path.getsize(a.out) // 1024} KB")


if __name__ == "__main__":
    main()
