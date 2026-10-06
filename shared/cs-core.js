// ClipSync core: end-to-end encryption + encrypted file transfer.
// Shared by the Edge extension (side panel + background worker) and the iPhone web app.
//
// - Your passphrase -> PBKDF2-SHA256 (600k rounds, per-account salt) -> AES-256-GCM key.
// - The key is stored only on each device (IndexedDB, non-extractable). Supabase never sees it.
// - Text, previews, file names and file contents are encrypted before upload.
// - Files are split into 8 MB encrypted chunks (Supabase free plan caps a single object at 50 MB).
(function (root) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const CHUNK = 8 * 1024 * 1024;
  const MAX_FILE = 200 * 1024 * 1024;
  const FILE_DAYS = 7;
  const VERIFY = "clipsync-key-check-v1";

  // ---------- base64 ----------
  function b64(bytes) {
    let s = ""; const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) { const r = atob(s); const u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; }

  // ---------- key handling ----------
  async function deriveKey(pass, saltB64, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // IndexedDB keystore (works in pages and service workers)
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("clipsync", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("keys", mode); const st = tx.objectStore("keys");
      const req = fn(st); tx.oncomplete = () => { db.close(); res(req && req.result); }; tx.onerror = () => rej(tx.error);
    });
  }
  let cachedKey = null;
  async function loadKey() {
    if (cachedKey) return cachedKey;
    try { cachedKey = (await idbDo("readonly", (s) => s.get("main"))) || null; } catch { cachedKey = null; }
    return cachedKey;
  }
  async function saveKey(key) { await idbDo("readwrite", (s) => s.put(key, "main")); cachedKey = key; }
  function resetCache() { cachedKey = null; }
  async function forgetKey() { cachedKey = null; try { await idbDo("readwrite", (s) => s.delete("main")); } catch {} }

  async function getKeyRecord(sb) {
    const { data, error } = await sb.from("user_keys").select("*").maybeSingle();
    if (error) throw error;
    return data;
  }
  // First device: create the passphrase
  async function setupPassphrase(sb, pass) {
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = 600000;
    const key = await deriveKey(pass, salt, iterations);
    const verifier = await encText(key, VERIFY);
    const { error } = await sb.from("user_keys").insert({ salt, iterations, verifier });
    if (error) throw error;
    await saveKey(key);
    return key;
  }
  // Other devices: unlock with the same passphrase
  async function unlock(sb, pass) {
    const rec = await getKeyRecord(sb);
    if (!rec) throw new Error("No passphrase has been set up yet");
    const key = await deriveKey(pass, rec.salt, rec.iterations);
    try { if ((await decText(key, rec.verifier)) !== VERIFY) return null; } catch { return null; }
    await saveKey(key);
    return key;
  }

  // ---------- encrypt / decrypt ----------
  async function encBytes(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return out;
  }
  async function decBytes(key, data) {
    const u = new Uint8Array(data);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, key, u.subarray(12)));
  }
  async function encText(key, text) { return "v1:" + b64(await encBytes(key, enc.encode(text))); }
  async function decText(key, s) {
    if (!s || !s.startsWith("v1:")) throw new Error("not encrypted");
    return dec.decode(await decBytes(key, unb64(s.slice(3))));
  }

  // ---------- messages ----------
  function kindForFile(type, isFolder) {
    if (isFolder) return "folder";
    if ((type || "").startsWith("image/")) return "image";
    if ((type || "").startsWith("video/")) return "video";
    return "file";
  }
  const ICON = { image: "📷", video: "🎬", file: "📎", folder: "🗂" };
  function humanSize(n) {
    if (n == null) return "";
    const u = ["B", "KB", "MB", "GB"]; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
  }

  // Turn a row into something displayable. Never throws.
  async function decodeMessage(key, m) {
    const out = { id: m.id, kind: m.kind, encrypted: !!m.encrypted, text: "", file: null, locked: false };
    try {
      if (m.encrypted) {
        if (!key) { out.locked = true; return out; }
        const plain = await decText(key, m.body);
        if (["image", "video", "file", "folder"].includes(m.kind)) {
          out.file = { ...JSON.parse(plain), path: m.file_path, chunks: m.chunk_count, expired: !m.file_path };
        } else out.text = plain;
      } else {
        out.text = m.body || "";
        if (m.file_name) out.file = { name: m.file_name, type: m.mime_type, size: m.size_bytes, path: m.file_path, chunks: m.chunk_count, expired: !m.file_path, legacy: true };
      }
    } catch { out.locked = true; }
    return out;
  }

  function previewOf(text) { const t = text.replace(/\s+/g, " ").trim(); return t.length > 160 ? t.slice(0, 157) + "…" : t; }

  async function sendText(sb, key, { text, senderId, targetId }) {
    const kind = /^https?:\/\/\S+$/i.test(text.trim()) ? "link" : "text";
    const row = {
      kind, sender_device_id: senderId, target_device_id: targetId || null, encrypted: true,
      body: await encText(key, text), preview: await encText(key, previewOf(text)),
    };
    const { data, error } = await sb.from("messages").insert(row).select().single();
    if (error) throw error;
    return data;
  }

  // blob: File/Blob. name/type override. onProgress(fraction)
  async function sendFile(sb, key, { blob, name, type, isFolder, senderId, targetId, userId, onProgress }) {
    type = type || blob.type || "application/octet-stream";
    name = name || blob.name || "file";
    if (blob.size > MAX_FILE) throw new Error(`${name} is ${humanSize(blob.size)} — the limit is ${humanSize(MAX_FILE)}`);
    const id = crypto.randomUUID();
    const folder = `${userId}/${id}`;
    const chunks = Math.max(1, Math.ceil(blob.size / CHUNK));
    const uploaded = [];
    try {
      for (let i = 0; i < chunks; i++) {
        const plain = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
        const sealed = await encBytes(key, plain);
        const path = `${folder}/${i}`;
        const { error } = await sb.storage.from("clips").upload(path, sealed, { contentType: "application/octet-stream", upsert: false });
        if (error) throw error;
        uploaded.push(path);
        onProgress && onProgress((i + 1) / chunks);
      }
      const kind = kindForFile(type, isFolder);
      const meta = { name, type, size: blob.size };
      const row = {
        id, kind, sender_device_id: senderId, target_device_id: targetId || null, encrypted: true,
        body: await encText(key, JSON.stringify(meta)),
        preview: await encText(key, `${ICON[kind]} ${name}`),
        file_path: folder, chunk_count: chunks, size_bytes: blob.size,
        expires_at: new Date(Date.now() + FILE_DAYS * 864e5).toISOString(),
      };
      const { data, error } = await sb.from("messages").insert(row).select().single();
      if (error) throw error;
      return data;
    } catch (e) {
      if (uploaded.length) await sb.storage.from("clips").remove(uploaded).catch(() => {});
      throw e;
    }
  }

  // Download + decrypt -> Blob
  async function fetchFile(sb, key, file, onProgress) {
    if (!file.path) throw new Error("This file has expired");
    const parts = [];
    for (let i = 0; i < (file.chunks || 1); i++) {
      const { data, error } = await sb.storage.from("clips").download(`${file.path}/${i}`);
      if (error) throw error;
      const buf = await data.arrayBuffer();
      parts.push(file.legacy ? new Uint8Array(buf) : await decBytes(key, buf));
      onProgress && onProgress((i + 1) / (file.chunks || 1));
    }
    return new Blob(parts, { type: file.type || "application/octet-stream" });
  }

  async function deleteMessage(sb, m) {
    if (m.file_path) {
      const paths = Array.from({ length: m.chunk_count || 1 }, (_, i) => `${m.file_path}/${i}`);
      await sb.storage.from("clips").remove(paths).catch(() => {});
    }
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) throw error;
  }

  // Wipe everything and remove the passphrase record (used when the passphrase is forgotten)
  async function resetEncryption(sb, userId) {
    await deleteAll(sb, userId);
    const { error } = await sb.from("user_keys").delete().eq("user_id", userId);
    if (error) throw error;
    await forgetKey();
  }

  async function deleteAll(sb, userId) {
    const { data } = await sb.from("messages").select("id,file_path,chunk_count").not("file_path", "is", null);
    const paths = (data || []).flatMap((m) => Array.from({ length: m.chunk_count || 1 }, (_, i) => `${m.file_path}/${i}`));
    for (let i = 0; i < paths.length; i += 100) await sb.storage.from("clips").remove(paths.slice(i, i + 100)).catch(() => {});
    const { error } = await sb.from("messages").delete().eq("user_id", userId);
    if (error) throw error;
  }

  // ---------- folders -> zip (needs fflate loaded as global `fflate`) ----------
  // entries: [{ path: "Folder/sub/file.txt", file: File }]
  const STORED = /\.(jpe?g|png|gif|webp|heic|mp4|mov|m4v|mkv|webm|mp3|m4a|aac|zip|7z|rar|gz|pdf|docx|xlsx|pptx)$/i;
  async function zipEntries(entries, onProgress) {
    if (!root.fflate) throw new Error("zip library missing");
    const total = entries.reduce((n, e) => n + e.file.size, 0);
    if (total > MAX_FILE) throw new Error(`Folder is ${humanSize(total)} — the limit is ${humanSize(MAX_FILE)}`);
    const out = [];
    let err = null;
    const zip = new root.fflate.Zip((e, chunk) => { if (e) err = e; else out.push(chunk); });
    let done = 0;
    for (const { path, file } of entries) {
      const big = file.size > 4 * 1024 * 1024 || STORED.test(path);
      const f = big ? new root.fflate.ZipPassThrough(path) : new root.fflate.ZipDeflate(path, { level: 6 });
      f.mtime = file.lastModified || Date.now();
      zip.add(f);
      const step = 4 * 1024 * 1024;
      if (file.size === 0) f.push(new Uint8Array(0), true);
      for (let off = 0; off < file.size; off += step) {
        const piece = new Uint8Array(await file.slice(off, off + step).arrayBuffer());
        f.push(piece, off + step >= file.size);
        done += piece.length;
        onProgress && onProgress(total ? done / total : 1);
      }
      if (err) throw err;
    }
    zip.end();
    if (err) throw err;
    return new Blob(out, { type: "application/zip" });
  }

  // Walk a dropped folder (DataTransferItem.webkitGetAsEntry())
  async function readDroppedEntry(entry, prefix = "") {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [{ path: prefix + entry.name, file }];
    }
    const reader = entry.createReader();
    const all = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      all.push(...batch);
    }
    const out = [];
    for (const e of all) out.push(...(await readDroppedEntry(e, prefix + entry.name + "/")));
    return out;
  }

  root.CS = {
    CHUNK, MAX_FILE, FILE_DAYS, ICON, humanSize, b64, unb64,
    loadKey, saveKey, forgetKey, resetCache, getKeyRecord, setupPassphrase, unlock, deriveKey,
    encText, decText, encBytes, decBytes,
    decodeMessage, sendText, sendFile, fetchFile, deleteMessage, deleteAll, resetEncryption,
    zipEntries, readDroppedEntry, kindForFile,
  };
})(typeof self !== "undefined" ? self : globalThis);
