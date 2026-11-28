#!/bin/sh
# Builds "Swipe Clean Companion.app" (menu bar app) into companion-mac/build/.
set -e
cd "$(dirname "$0")"
APP="build/Swipe Clean Companion.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target arm64-apple-macos13 main.swift -o "$APP/Contents/MacOS/SwipeCleanCompanion" \
  -framework AppKit -framework Photos -framework Network -framework CryptoKit
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Swipe Clean Companion</string>
  <key>CFBundleIdentifier</key><string>com.aayushmk.swipeclean.companion</string>
  <key>CFBundleExecutable</key><string>SwipeCleanCompanion</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPhotoLibraryUsageDescription</key><string>Swipe Clean Companion shows the photos on this Mac to your phone so you can find duplicates and clean them up.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Your phone connects to this Mac over your home network.</string>
  <key>NSBonjourServices</key><array><string>_swipeclean._tcp</string></array>
</dict></plist>
PLIST
codesign --force --deep -s - "$APP"
echo "Built $APP"
