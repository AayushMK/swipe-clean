# Swipe Clean

A web app (PWA) for cleaning up photos Tinder-style: swipe right to keep, left to delete.
It installs from Safari or Chrome. There's no App Store, no build step, and nothing to compile.

## Features
- Grid of photos still to review. Tap one to open the swipe view at that photo.
- Swipe right or ✓ to keep. Swipe left or ✕ to delete. ↶ undoes. Arrow keys work on desktop.
- Daily goal (default 100) with a progress ring and a streak.
- Daily reminder: Settings → "Add daily reminder to my calendar" adds a repeating calendar event.
- Deleted photos wait in **Deleted** for N days (default 10). You can restore them there, and after that they're removed for good.
- Works offline once loaded. Share button sends the link to friends.

## Run locally
```bash
python3 -m http.server 8765
```
Then open http://localhost:8765.

## Put it online (needed to install on phones and share)
It's just static files, so any HTTPS host works:
- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push this folder to a repo, then Settings → Pages → deploy from branch
- **Vercel / Cloudflare Pages**: import the folder; there's no build command

Then on the phone, open the URL:
- **iPhone (Safari)**: Share → Add to Home Screen
- **Android (Chrome)**: tap "Install" in the app, or ⋮ → Install app

After changing any file, bump `VERSION` in `sw.js` so installed copies update.

## Important limitation of web apps
Browsers don't let websites read or delete your phone's photo library. So:
- You **pick** photos to review with the system photo picker. The app works on copies stored in the browser.
- "Deleted" removes the photo **from this app**, not from your camera roll. The original still has to be deleted in the Photos / Gallery app.

Removing photos from the real library needs a native wrapper. This code can be wrapped with
[Capacitor](https://capacitorjs.com) plus a photo-library plugin to get that, but then it's installed
through the App Store / TestFlight or as an Android APK, not from Safari.
