#!/bin/sh
# Copy the web app into the iOS bundle. Run after changing index.html, fonts or icons.
set -e
cd "$(dirname "$0")"
rm -rf Intesa/Web && mkdir -p Intesa/Web
cp ../index.html Intesa/Web/index.html
cp -R ../fonts Intesa/Web/fonts
cp -R ../icons Intesa/Web/icons
echo "web copied into Intesa/Web"
