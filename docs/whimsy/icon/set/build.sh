#!/bin/sh
# Builds the Whimsy icon set and installs it:
#   - src/zen/images/app-icons/<id>.png (512px, used by the Settings picker
#     and swapped into the Dock at runtime)
#   - configs/branding/{release,twilight}: the app's built-in icon
# Needs: python3, rsvg-convert, magick, iconutil.
set -e
cd "$(dirname "$0")"
ROOT=../../../..

python3 make_set.py

OUT=$ROOT/src/zen/images/app-icons
mkdir -p "$OUT"
for svg in *.svg; do
  rsvg-convert -w 512 "$svg" -o "$OUT/${svg%.svg}.png"
done

brand() { # brand <folder> <icon id> <private icon id>
  dir=$ROOT/configs/branding/$1
  tmp=$(mktemp -d)
  rsvg-convert -w 1024 "$2.svg" -o "$tmp/1024.png"
  rsvg-convert -w 1024 "$3.svg" -o "$tmp/private.png"
  for s in 16 22 24 32 48 64 128 256 512 1024; do
    magick "$tmp/1024.png" -resize ${s}x${s} "$dir/logo$s.png"
  done
  cp "$tmp/1024.png" "$dir/logo.png"
  cp "$tmp/1024.png" "$dir/logo-mac.png"

  set_dir=$tmp/firefox.iconset
  mkdir "$set_dir"
  for s in 16 32 128 256 512; do
    magick "$tmp/1024.png" -resize ${s}x${s} "$set_dir/icon_${s}x${s}.png"
    magick "$tmp/1024.png" -resize $((s*2))x$((s*2)) "$set_dir/icon_${s}x${s}@2x.png"
  done
  iconutil -c icns "$set_dir" -o "$dir/firefox.icns"

  magick "$tmp/1024.png" -define icon:auto-resize=256,64,48,32,16 "$dir/firefox.ico"
  magick "$tmp/1024.png" -define icon:auto-resize=64,48,32,16 "$dir/firefox64.ico"
  magick "$tmp/private.png" -define icon:auto-resize=256,64,48,32,16 "$dir/pbmode.ico"
  magick "$tmp/private.png" -resize 270x270 "$dir/PrivateBrowsing_150.png"
  magick "$tmp/private.png" -resize 126x126 "$dir/PrivateBrowsing_70.png"
  magick "$tmp/1024.png" -resize 270x270 "$dir/VisualElements_150.png"
  magick "$tmp/1024.png" -resize 126x126 "$dir/VisualElements_70.png"
  rm -rf "$tmp"
}

brand release daydream stargazer
brand twilight stargazer stargazer
echo "installed"
