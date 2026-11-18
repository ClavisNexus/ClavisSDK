#!/usr/bin/env python3
"""ボタンの字（Familjen Grotesk 600 の、ボタンの文言の字だけの部分集合）を作る。

このパッケージのディレクトリで:

    python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
    .venv/bin/python scripts/build-button-font.py

読むもの
  fonts/familjen-grotesk-latin-wght.woff2   Google Fonts が配る latin の可変フォント（手を入れていない。OFL）
  src/text.ts                               ボタンの文言（CLAVIS_BUTTON_TEXT の label）
書くもの
  src/clavis-button-grotesk.woff2           太さ 600 の静的な字。文言の ASCII の字だけ
  src/clavis-button-grotesk.json            作った材料と、出来上がりの SHA-256

文言を変えたら作り直す。試験が、文言の字がこの部分集合に揃っていることと、ファイルが記録の SHA-256 のままであることを確かめる。
同じ版の fontTools と brotli なら、同じバイト列になる（時刻を書き換えない）。
"""

from __future__ import annotations

import hashlib
import json
import re
from io import BytesIO
from pathlib import Path

import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

PACKAGE = Path(__file__).resolve().parent.parent
SOURCE = PACKAGE / "fonts" / "familjen-grotesk-latin-wght.woff2"
TEXT = PACKAGE / "src" / "text.ts"
OUT = PACKAGE / "src" / "clavis-button-grotesk.woff2"
RECORD = PACKAGE / "src" / "clavis-button-grotesk.json"
WEIGHT = 600

LABEL = re.compile(r'label: \{ "sign-in": "([^"]*)", link: "([^"]*)" \}')


def label_chars() -> str:
    labels = [s for pair in LABEL.findall(TEXT.read_text("utf-8")) for s in pair]
    if len(labels) < 4:
        raise SystemExit("the button labels were not found in src/text.ts")
    # 和文は端末の書体で描く。この字が受け持つのは ASCII だけ
    return "".join(sorted({c for s in labels for c in s if " " <= c <= "~"}))


def unicode_range(chars: str) -> str:
    points = sorted(ord(c) for c in chars)
    runs: list[list[int]] = []
    for p in points:
        if runs and p == runs[-1][1] + 1:
            runs[-1][1] = p
        else:
            runs.append([p, p])
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in runs)


def main() -> None:
    chars = label_chars()
    source = SOURCE.read_bytes()
    font = TTFont(BytesIO(source), recalcTimestamp=False)
    static = instantiateVariableFont(font, {"wght": WEIGHT}, updateFontNames=False)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["kern", "liga", "calt"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=chars)
    subsetter.subset(static)
    static.recalcTimestamp = False
    static.flavor = "woff2"
    buf = BytesIO()
    static.save(buf)
    data = buf.getvalue()
    OUT.write_bytes(data)
    record = {
        "source": SOURCE.name,
        "sourceSha256": hashlib.sha256(source).hexdigest(),
        "weight": WEIGHT,
        "text": chars,
        "unicodeRange": unicode_range(chars),
        "fonttools": fontTools.version,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
    }
    RECORD.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"{OUT.name}: {len(data)} bytes, {len(chars)} characters ({record['unicodeRange']})")


if __name__ == "__main__":
    main()
