# ClipSync

End-to-end encrypted clipboard, chat, files and folders between your PCs (Edge extension) and iPhone (home-screen web app), on a free Supabase backend.

- **iPhone app:** https://buttaz95.github.io/Clipsync/ — open in Safari → Share → Add to Home Screen.
- **Edge extension:** the `extension/` folder — `edge://extensions` → Developer mode → Load unpacked.

## Security
- Your passphrase → PBKDF2-SHA256 (600k rounds) → AES-256-GCM key, kept only on your devices.
- Text, file names and file contents are encrypted before upload; notifications are decrypted on the phone.
- Files up to 200 MB (folders are zipped first), kept for 7 days, then deleted automatically.
- The key in the code is Supabase's public "publishable" key, which is safe to publish. Access is also limited by your login.

`shared/cs-core.js` is the shared encryption/file module; `extension/lib/cs-core.js` is a copy of it.
