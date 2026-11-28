# Swipe Clean Companion (Mac)

A small menu-bar app that lets the Swipe Clean phone app see the photos on this Mac, find copies
of phone photos, and move Mac copies to the Trash.

- **Build:** `./build.sh` → `build/Swipe Clean Companion.app` (open it; it lives in the menu bar).
- **Pair:** in the phone app tap **Your computer**, pick this Mac, type the 6-digit code from the menu bar.
- **What it shares:** the Photos app library (asks for Photos access once) and any folders you add from
  the menu. Only to phones you paired, only on your local network.
- **Security:** HTTPS with a self-signed certificate made on first launch; the phone pins its SHA-256
  fingerprint (announced over Bonjour and checked on every request). Pairing codes are single-use and
  change every 5 minutes. "Unpair all phones" in the menu revokes every phone.
- **Deleting:** folder files go to the Trash (Put Back works). Photos-library items go to Recently
  Deleted; macOS shows its own confirmation on the Mac.
- **Settings/keys:** `~/Library/Application Support/SwipeCleanCompanion/`.

API (all JSON, `Authorization: Bearer <token>` except `/info` and `/pair`):
`GET /info`, `POST /pair {code,name}`, `GET /items`, `GET /thumb?id=&size=`, `POST /trash {ids}`.
A Windows companion can implement the same API.
