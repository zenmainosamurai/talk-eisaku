# public/ のアイコンから、Android 用のアイコンと起動画面のアイコンを作り直す
# 使い方（リポジトリの一番上で）：python3 scripts/make_android_icons.py
# 必要なもの：Python 3 と Pillow（pip install pillow）
# 作るもの：android/app/src/main/res の mipmap-*/ic_launcher*.png と drawable-*/splash_icon.png
# アダプティブアイコンの背景色は values/ic_launcher_background.xml（藍色）。アイコンの色を変えたら、そちらも直す
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android/app/src/main/res")
ICON = Image.open(os.path.join(ROOT, "public/icon-512.png")).convert("RGBA")           # 角丸の四角
MASK = Image.open(os.path.join(ROOT, "public/icon-maskable-512.png")).convert("RGBA")  # 全面が藍色
INDIGO = MASK.getpixel((5, 5))[:3]
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SCALE = 0.9                            # アダプティブアイコンの安全域（66dp）に収める

def resize(im, size):
    return im.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA")

# 前景：藍色を透明にして、白い吹き出しだけを残す（「英」の字は透明になり、背景の藍色が見える）
fg = Image.new("RGBA", MASK.size)
src, dst = MASK.load(), fg.load()
for y in range(MASK.height):
    for x in range(MASK.width):
        r, g, b, _ = src[x, y]
        a = max((c - i) / (255 - i) for c, i in zip((r, g, b), INDIGO))
        dst[x, y] = (255, 255, 255, round(max(0.0, min(1.0, a)) * 255))

def foreground(size):
    c = round(size * SCALE)
    if (size - c) % 2: c -= 1
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(resize(fg, c), ((size - c) // 2, (size - c) // 2))
    return out

def round_icon(size):
    # アダプティブアイコンを丸で切り抜いたときと同じ見え方にする（108dp のうち中央の 72dp を使う）
    full = round(size * 108 / 72)
    if (full - size) % 2: full += 1
    layer = Image.new("RGBA", (full, full), INDIGO + (255,))
    layer.alpha_composite(foreground(full))
    o = (full - size) // 2
    base = layer.crop((o, o, o + size, o + size))
    big = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(big).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    base.putalpha(big.resize((size, size), Image.LANCZOS))
    return base

for name, k in DENS.items():
    d = f"{RES}/mipmap-{name}"
    resize(ICON, round(48 * k)).save(f"{d}/ic_launcher.png", optimize=True)
    round_icon(round(48 * k)).save(f"{d}/ic_launcher_round.png", optimize=True)
    foreground(round(108 * k)).save(f"{d}/ic_launcher_foreground.png", optimize=True)
    os.makedirs(f"{RES}/drawable-{name}", exist_ok=True)
    resize(ICON, round(96 * k)).save(f"{RES}/drawable-{name}/splash_icon.png", optimize=True)
print("indigo", "#%02X%02X%02X" % INDIGO)
