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
- Grid of photos to review. Tap one to start swiping from that photo.
- Swipe right or ✓ to keep. Swipe left or ✕ to delete. ↶ undoes.
- Daily goal (default 100) with progress ring and streak; daily reminder.
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
Needs Android Studio (includes the Android SDK and Java).
1. `npm install` then `npm run android` (opens Android Studio).
2. **Run ▶** to a connected phone, or **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.
3. Share the `.apk` file with anyone. They open it and allow “Install unknown apps”.

## After changing the app
```bash
npm run sync                      # copy www/ into the iOS and Android projects
```
Then rebuild from Xcode / Android Studio.

Website: bump `VERSION` in `www/sw.js`, commit, then publish `www/`:
```bash
git push origin `git subtree split --prefix www main`:gh-pages --force
```

## Run the website locally
```bash
python3 -m http.server 8765 -d www
```
