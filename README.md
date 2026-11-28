# Swipe Clean

Clean up your photos Tinder-style: swipe right to keep, left to delete.

One codebase (`www/`) ships two ways:

| | **Native app** (iPhone / Android) | **Website** (any browser) |
|---|---|---|
| Photos | Your whole photo library, automatically | Photos you pick with the photo picker (copies) |
| Delete | **Really deletes from your phone** | Removes only from the app |
| Daily reminder | Real notification every day | Calendar event (.ics) |
| Install | Xcode (iPhone) / APK (Android) | Safari or Chrome → Add to Home Screen |

**Live website:** https://aayushmk.github.io/swipe-clean/

## Features
- Grid of photos to review. Tap one to start swiping from that photo; tap the photo again to see it full size (pinch to zoom, swipe sideways for the next one).
- Select several photos at once: **Select**, then tap or drag across them like the iPhone Photos app (two-finger drag or long-press also starts it). To review → Keep / Delete, Kept → Back to review / Delete, Deleted → Restore / Delete permanently.
- Swipe right or ✓ to keep. Swipe left or ✕ to delete. ↶ undoes.
- **Share** selected photos in original quality (Share, or one .zip that chat apps send untouched as a document; iPhone can convert HEIC to JPEG). Copies are temporary and deleted right after.
- **Similar photos** (button in the full-size view) and **Find duplicates** (extra copies pre-selected for deleting). Uses an index built on the phone: Apple Vision image fingerprints on iPhone, a small shape/colour fingerprint on Android.
- **People (beta):** Android uses real face recognition on the phone (OpenCV's YuNet finds faces, SFace recognises them, run with ONNX Runtime). iPhone still uses the rough phase-1 grouping until SFace is converted to Core ML.
- **Zoom:** pinch the grid to change photos per row; pinch a swipe card to zoom in place; the full-size view zooms to the photo's real pixels.
- Daily goal (default 100) with progress ring and streak.
- Reminder (apps): every day, or only on days you take lots of photos (you pick how many and what time). On iPhone the busy-day check uses Background App Refresh, so iOS decides exactly when it runs.
- **Deleted** holds photos for N days (default 10) so you can restore them. After that:
  - **iPhone:** iOS asks “Allow Swipe Clean to delete N photos?” (Apple requires this for every delete), then the photos move to the Photos app’s *Recently Deleted* for 30 days.
  - **Android 11+:** Android shows a similar confirmation and deletes them.
  - The app asks automatically when you open it. If you tap “Don’t Allow”, a red banner lets you try again later.

## Project layout
```
www/            the app (HTML/CSS/JS) — used by the website AND the native apps
ios/            Xcode project (Capacitor). Native code: ios/App/App/PhotoLibraryPlugin.swift
android/        Android Studio project. Native code: android/app/src/main/java/.../PhotoLibraryPlugin.java
assets/         source icon used to generate app icons/splash
```

## Install on your iPhone
Needs a Mac with Xcode and a free Apple ID.
1. `npm install` then `npm run ios` (copies `www/` into the app and opens Xcode).
2. In Xcode: click **App** in the left sidebar → **Signing & Capabilities** → **Team** → pick your Apple ID (add it under Xcode → Settings → Accounts if needed).
3. Plug in your iPhone (unlock it, tap **Trust**), pick it at the top of Xcode, press **▶ Run**.
4. First time only, on the iPhone: Settings → General → VPN & Device Management → trust your developer certificate. Also turn on Settings → Privacy & Security → **Developer Mode** if asked.

With a free Apple ID the app stops opening after 7 days. Re-run from Xcode to refresh it.
To share with other iPhone users you need the paid Apple Developer Program ($99/year) and TestFlight or the App Store.

## Install on Android
**Download:** https://aayushmk.github.io/swipe-clean/SwipeClean.apk (opening the website on an Android phone also shows a download link).
1. Open that link on the phone, or send the `.apk` to it (Google Drive, email, WhatsApp, USB cable).
2. Open it on the phone. Android asks to allow installing from that app (Files, Chrome, Drive…) the first time: tap **Settings → Allow from this source**, go back, tap **Install**.
3. Open Swipe Clean and allow access to photos and videos.

Build it yourself (needs Java 21 + Android SDK; on this Mac they're installed via Homebrew):
```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=$HOME/Library/Android/sdk
npm run sync && (cd android && ./gradlew assembleDebug)
```
The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

## After changing the app
```bash
npm run sync                      # copy www/ into the iOS and Android projects
```
Then rebuild from Xcode / Android Studio.

Website: bump `VERSION` in `www/sw.js`, commit, then publish `www/` and `SwipeClean.apk` (copy a fresh APK to the project root first):
```bash
npm run deploy
```

## Run the website locally
```bash
python3 -m http.server 8765 -d www
```
