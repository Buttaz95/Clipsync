// ClipSync iPhone web app (end-to-end encrypted)
const CLIPSYNC = {
  url: "https://aaxtchjpfiawlybsaqmi.supabase.co",
  key: "sb_publishable_pFIvQdq9RDFO-TUpvYlH3w_0xUBZpp7",
  vapid: "BD6UfCz-lYc6AHX5sY1AxY83U5h4SoXqlBFSi7a-wIvUgcyq-NeaDrLP-ysLD4JU-xe7yIJ5qk_GdV_Ee7yyEQQ",
};
const sb = supabase.createClient(CLIPSYNC.url, CLIPSYNC.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem("clipsync." + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("clipsync." + k) : localStorage.setItem("clipsync." + k, v); } catch {} },
};

let me = null;
let deviceId = store.get("deviceId");
let devices = new Map();
let channel = null;
let key = null;
const shown = new Map();
const blobs = new Map();
let lastDay = null;
let openId = new URLSearchParams(location.search).get("open");

const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ---------- helpers ----------
function show(view) { for (const v of ["login", "device", "key", "chat"]) $("view-" + v).hidden = v !== view; }
function toast(text, ms = 1800) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); }
function fmtTime(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDay(d) {
  const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); ta.remove(); toast(ok ? "Copied" : "Couldn't copy");
  }
}
function visibleToMe(m) { return !m.target_device_id || m.target_device_id === deviceId || m.sender_device_id === deviceId; }
function targetId() { return $("target").value || null; }
function b64ToBytes(b64) {
  const p = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------- startup ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    $("install-hint").hidden = !(isIOS && !isStandalone);
    return show("login");
  }
  me = session.user;
  if (deviceId) {
    const { data, error } = await sb.from("devices").select("id").eq("id", deviceId).maybeSingle();
    if (!error && !data) { deviceId = null; store.set("deviceId", null); }
  }
  if (!deviceId) return show("device");
  if (!(await ensureKey())) return;
  openChat();
}

async function ensureKey() {
  let rec;
  try { rec = await CS.getKeyRecord(sb); } catch (e) { toast(e.message); return false; }
  key = await CS.loadKey();
  if (rec && key) {
    try { await CS.decText(key, rec.verifier); return true; } catch { await CS.forgetKey(); key = null; }
  }
  if (!rec) await CS.forgetKey();
  showKeyView(rec ? "unlock" : "setup");
  return false;
}

function showKeyView(mode) {
  $("key-form").dataset.mode = mode;
  $("key-error").textContent = "";
  $("key-pass").value = ""; $("key-pass2").value = "";
  const setup = mode === "setup";
  $("key-title").textContent = setup ? "Set an encryption passphrase" : "Enter your passphrase";
  $("key-intro").textContent = setup
    ? "Everything you send — text, photos, videos, files — is locked with this before it leaves your iPhone. Supabase only ever stores scrambled data."
    : "Your messages are end-to-end encrypted. Enter the passphrase you set on your first device to unlock this iPhone.";
  $("key-pass2").hidden = !setup; $("key-pass2").required = setup;
  $("key-pass").autocomplete = setup ? "new-password" : "current-password";
  $("key-submit").textContent = setup ? "Turn on encryption" : "Unlock";
  $("key-warn").textContent = setup
    ? "Write it down somewhere safe. If you forget it, nobody can recover your messages — not even you."
    : "";
  $("btn-key-reset").hidden = setup;
  show("key");
}

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode;
  const pass = $("key-pass").value;
  $("key-error").textContent = "";
  if (mode === "setup") {
    if (pass.length < 8) return ($("key-error").textContent = "Use at least 8 characters — a few random words works well.");
    if (pass !== $("key-pass2").value) return ($("key-error").textContent = "The two passphrases don't match.");
  }
  const btn = $("key-submit"); btn.disabled = true; btn.textContent = "Working…";
  try {
    if (mode === "setup") key = await CS.setupPassphrase(sb, pass);
    else {
      key = await CS.unlock(sb, pass);
      if (!key) { $("key-error").textContent = "That passphrase isn't right."; return; }
    }
    $("key-pass").blur();
    navigator.serviceWorker?.controller?.postMessage({ type: "key-changed" });
    openChat();
  } catch (err) {
    $("key-error").textContent = err.message || String(err);
    if (mode === "setup" && /duplicate|unique/i.test(err.message || "")) showKeyView("unlock");
  } finally {
    btn.disabled = false; btn.textContent = mode === "setup" ? "Turn on encryption" : "Unlock";
  }
});

$("btn-key-reset").addEventListener("click", async () => {
  if (!confirm("Reset encryption?\n\nThis permanently deletes ALL messages and files on every device, then lets you choose a new passphrase.")) return;
  if (prompt("Type DELETE to confirm") !== "DELETE") return;
  try { await CS.resetEncryption(sb, me.id); showKeyView("setup"); toast("Encryption reset"); }
  catch (e) { toast(e.message); }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const btn = e.submitter; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
  btn.disabled = false;
  if (error) { $("login-error").textContent = error.message; return; }
  boot();
});

$("device-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("device-name").value.trim();
  if (!name) return;
  const { data, error } = await sb.from("devices").insert({ name, platform: isIOS ? "iphone" : "other" }).select().single();
  if (error) { $("device-error").textContent = error.message; return; }
  deviceId = data.id; store.set("deviceId", deviceId);
  if (await ensureKey()) openChat();
});

// ---------- chat ----------
async function loadDevices() {
  const { data } = await sb.from("devices").select("*").order("created_at");
  devices = new Map((data || []).map((d) => [d.id, d]));
  $("me-label").textContent = devices.get(deviceId) ? "🔒 " + devices.get(deviceId).name : "";
  const sel = $("target"); const prev = sel.value;
  sel.innerHTML = `<option value="">All devices</option>` +
    [...devices.values()].filter((d) => d.id !== deviceId).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function fetchMessages() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) { toast(error.message); return []; }
  return (data || []).reverse().filter(visibleToMe);
}

async function openChat() {
  show("chat");
  await loadDevices();
  sb.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", deviceId).then(() => {});
  const list = await fetchMessages();
  $("messages").innerHTML = ""; shown.clear(); lastDay = null;
  if (!list.length) $("messages").innerHTML = `<div class="empty" id="empty">No messages yet.<br/>Type below, tap <b>Paste</b> to send what you copied, or <b>Files</b> for photos, videos and documents.<br/><br/>🔒 Everything is end-to-end encrypted.</div>`;
  list.forEach(renderMessage);
  scrollToBottom();
  subscribe();
  refreshPushUI();
  focusOpened();
  clearBadge();
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("ios-" + deviceId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
      if (visibleToMe(p.new)) { renderMessage(p.new); scrollToBottom(); }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => {
      if (shown.has(p.new.id)) { shown.set(p.new.id, p.new); fillMessage(document.querySelector(`[data-id="${p.new.id}"]`), p.new); }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => {
      document.querySelector(`[data-id="${p.old.id}"]`)?.remove(); shown.delete(p.old.id);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => loadDevices())
    .subscribe((status) => {
      const dot = $("status-dot");
      dot.className = "dot " + (status === "SUBSCRIBED" ? "live" : ["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status) ? "down" : "");
    });
}

function scrollToBottom() { const m = $("messages"); m.scrollTop = m.scrollHeight; }
function nearBottom() { const m = $("messages"); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }

function renderMessage(m) {
  if (shown.has(m.id)) return;
  shown.set(m.id, m);
  $("empty")?.remove();
  const when = new Date(m.created_at);
  const day = fmtDay(when);
  if (day !== lastDay) {
    lastDay = day;
    const d = document.createElement("div"); d.className = "day"; d.textContent = day; $("messages").appendChild(d);
  }
  const mine = m.sender_device_id === deviceId;
  const from = devices.get(m.sender_device_id)?.name || "Removed device";
  const to = m.target_device_id ? " → " + (devices.get(m.target_device_id)?.name || "device") : "";
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "mine" : "theirs");
  el.dataset.id = m.id;
  el.innerHTML = `<div class="content"><div class="bubble muted">…</div></div>
    <div class="meta"><span>${mine ? "You" : esc(from)}${esc(to)} · ${fmtTime(when)}</span><span class="acts"></span></div>`;
  $("messages").appendChild(el);
  fillMessage(el, m);
}

async function fillMessage(el, m) {
  if (!el) return;
  const stick = nearBottom();
  const d = await CS.decodeMessage(key, m);
  const content = el.querySelector(".content"), acts = el.querySelector(".acts");
  acts.innerHTML = "";
  const act = (label, fn, cls = "") => {
    const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls;
    b.addEventListener("click", fn); acts.appendChild(b); return b;
  };
  if (d.locked) {
    content.innerHTML = `<div class="bubble locked">🔒 Can't decrypt this message</div>`;
  } else if (!d.file) {
    content.innerHTML = `<div class="bubble">${linkify(d.text)}</div>`;
    act("Copy", () => copyText(d.text));
    if (navigator.share) act("Share", () => navigator.share({ text: d.text }).catch(() => {}));
  } else {
    renderFile(content, act, m, d.file);
  }
  act("Delete", async () => {
    if (!confirm("Delete this on all devices?")) return;
    try { await CS.deleteMessage(sb, m); el.remove(); shown.delete(m.id); }
    catch (e) { toast(e.message); }
  }, "del");
  if (stick) scrollToBottom();
  if (m.id === openId) focusOpened();
}

// ---------- files ----------
function renderFile(content, act, m, f) {
  const kind = m.kind;
  const icon = CS.ICON[kind] || "📎";
  if (f.expired) {
    content.innerHTML = `<div class="file-card expired"><span class="ficon">${icon}</span><div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="small muted">Expired — files are kept for ${CS.FILE_DAYS} days</div></div></div>`;
    return;
  }
  content.innerHTML = `
    <div class="file-card ${kind}">
      <div class="preview"></div>
      <div class="frow"><span class="ficon">${icon}</span>
        <div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="small muted">${CS.humanSize(f.size)}${kind === "folder" ? " · zip" : ""}</div></div></div>
      <div class="progress" hidden><div></div></div>
    </div>`;
  const preview = content.querySelector(".preview");
  const bar = content.querySelector(".progress");
  const get = async () => {
    if (blobs.has(m.id)) return blobs.get(m.id);
    bar.hidden = false;
    try {
      const b = await CS.fetchFile(sb, key, f, (p) => (bar.firstElementChild.style.width = Math.round(p * 100) + "%"));
      blobs.set(m.id, b); return b;
    } finally { bar.hidden = true; }
  };
  // On iPhone the share sheet is how you "Save Image", "Save Video" or "Save to Files"
  const save = async () => {
    try {
      const b = await get();
      const file = new File([b], f.name, { type: f.type || b.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] }).catch((e) => { if (e.name !== "AbortError") throw e; });
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = f.name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      }
    } catch (e) { toast(e.message); }
  };
  const open = async () => {
    try { const b = await get(); window.open(URL.createObjectURL(b), "_blank"); } catch (e) { toast(e.message); }
  };
  if (kind === "image") {
    const showImg = async () => {
      try {
        const b = await get();
        preview.innerHTML = `<img alt="${esc(f.name)}" />`;
        const img = preview.querySelector("img"); img.src = URL.createObjectURL(b);
        if (nearBottom()) img.addEventListener("load", scrollToBottom, { once: true });
      } catch (e) { preview.innerHTML = `<div class="small muted pad">Couldn't load: ${esc(e.message)}</div>`; }
    };
    if (f.size <= 10 * 1024 * 1024) showImg();
    else { preview.innerHTML = `<button class="ghost small-btn">Show photo</button>`; preview.firstChild.addEventListener("click", showImg); }
  } else if (kind === "video") {
    preview.innerHTML = `<button class="play">▶ Play video</button>`;
    preview.firstChild.addEventListener("click", async () => {
      try {
        const b = await get();
        preview.innerHTML = `<video controls playsinline></video>`;
        const v = preview.querySelector("video"); v.src = URL.createObjectURL(b); v.play().catch(() => {});
      } catch (e) { toast(e.message); }
    });
  } else {
    act("Open", open);
  }
  act("Save", save);
}

function pendingBubble(label) {
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = "msg mine pending";
  el.innerHTML = `<div class="file-card"><div class="frow"><span class="ficon">⏳</span><div class="fmeta"><div class="fname">${esc(label)}</div><div class="small muted status">Encrypting…</div></div></div><div class="progress"><div></div></div></div>`;
  $("messages").appendChild(el); scrollToBottom();
  return {
    el,
    progress(p, txt) { el.querySelector(".progress div").style.width = Math.round(p * 100) + "%"; if (txt) el.querySelector(".status").textContent = txt; },
    fail(msg) { el.querySelector(".status").textContent = "Not sent: " + msg; el.classList.add("failed"); setTimeout(() => el.remove(), 6000); },
  };
}

async function sendBlob(blob, { name, type } = {}) {
  name = name || blob.name || "file";
  const ui = pendingBubble(name);
  try {
    const row = await CS.sendFile(sb, key, {
      blob, name, type, senderId: deviceId, targetId: targetId(), userId: me.id,
      onProgress: (p) => ui.progress(p, `Uploading ${Math.round(p * 100)}% of ${CS.humanSize(blob.size)}`),
    });
    blobs.set(row.id, blob);
    ui.el.remove();
    renderMessage(row);
  } catch (e) { ui.fail(e.message || String(e)); }
}

async function sendText(text) {
  text = text.replace(/\s+$/, "");
  if (!text.trim()) return;
  try {
    const row = await CS.sendText(sb, key, { text, senderId: deviceId, targetId: targetId() });
    renderMessage(row); scrollToBottom();
    return true;
  } catch (e) { toast("Not sent: " + e.message); return false; }
}

function focusOpened() {
  if (!openId) return;
  const el = document.querySelector(`[data-id="${openId}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" }); el.classList.add("flash");
  openId = null;
  history.replaceState(null, "", location.pathname);
}

function clearBadge() {
  navigator.clearAppBadge?.().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-badge" });
}

// ---------- composer ----------
const input = $("input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (!isIOS && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("btn-send").click(); }
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f) => sendBlob(f, { name: f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png` }));
});
$("btn-send").addEventListener("pointerdown", (e) => e.preventDefault()); // keep keyboard open
$("btn-send").addEventListener("click", async () => {
  const v = input.value;
  if (!v.trim()) return;
  input.value = ""; autosize();
  if ((await sendText(v)) === false) { input.value = v; autosize(); }
});
$("btn-paste").addEventListener("click", async () => {
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith("image/"));
        if (img) { const b = await it.getType(img); return sendBlob(b, { name: `pasted-${Date.now()}.${img.split("/")[1]}`, type: img }); }
      }
      for (const it of items) {
        if (it.types.includes("text/plain")) {
          const t = await (await it.getType("text/plain")).text();
          if (t.trim() && (await sendText(t))) toast("Sent from clipboard");
          return;
        }
      }
    }
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast("Clipboard is empty");
    if (await sendText(t)) toast("Sent from clipboard");
  } catch { toast("Paste was blocked — long-press the message box and tap Paste instead"); }
});
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => { [...e.target.files].forEach((f) => sendBlob(f)); e.target.value = ""; });

// Catch up when the app comes back to the foreground (iOS pauses it in the background)
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !deviceId || !key || $("view-chat").hidden) return;
  (await fetchMessages()).forEach(renderMessage);
  scrollToBottom(); subscribe(); clearBadge(); focusOpened();
});
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open" && e.data.id) { openId = e.data.id; fetchMessages().then((l) => { l.forEach(renderMessage); focusOpened(); }); }
});

// ---------- notifications ----------
async function pushState() {
  if (!pushSupported) return isIOS && !isStandalone ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}
async function refreshPushUI() {
  const s = await pushState();
  const labels = {
    on: "On for this device", off: "Off", denied: "Blocked — allow in iPhone Settings → Notifications → ClipSync",
    "needs-install": "Add ClipSync to your Home Screen first", unsupported: "Not supported in this browser",
  };
  $("push-status").textContent = labels[s];
  $("btn-push").hidden = s !== "off" && s !== "on";
  $("btn-push").textContent = s === "on" ? "Turn off" : "Turn on";
  $("push-banner").hidden = !(s === "off" && store.get("pushDismissed") !== "1");
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications not allowed"); return refreshPushUI(); }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CLIPSYNC.vapid) });
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions")
      .upsert({ device_id: deviceId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) throw error;
    toast("Notifications on");
  } catch (e) { toast("Couldn't turn on: " + (e.message || e)); }
  refreshPushUI();
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
  toast("Notifications off"); refreshPushUI();
}
$("btn-push").addEventListener("click", async () => ((await pushState()) === "on" ? disablePush() : enablePush()));
$("btn-push-banner").addEventListener("click", enablePush);
$("btn-push-dismiss").addEventListener("click", () => { store.set("pushDismissed", "1"); $("push-banner").hidden = true; });

// ---------- settings ----------
$("btn-settings").addEventListener("click", async () => {
  await loadDevices(); refreshPushUI();
  $("set-name").value = devices.get(deviceId)?.name || "";
  $("device-list").innerHTML = [...devices.values()].map((d) => `
    <li><span>${esc(d.name)} <span class="muted small">${d.platform}${d.id === deviceId ? " · this one" : ""}</span></span>
    ${d.id === deviceId ? "" : `<button class="ghost danger small-btn" data-remove="${d.id}">Remove</button>`}</li>`).join("");
  $("device-list").querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this device? If it's still in use it will ask for a new name next time it opens.")) return;
    await sb.from("devices").delete().eq("id", b.dataset.remove);
    b.closest("li").remove(); loadDevices();
  }));
  $("settings").hidden = false;
});
$("btn-close-settings").addEventListener("click", () => ($("settings").hidden = true));
$("settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("settings").hidden = true; });
$("btn-save-settings").addEventListener("click", async () => {
  const name = $("set-name").value.trim();
  if (name && name !== devices.get(deviceId)?.name) await sb.from("devices").update({ name }).eq("id", deviceId);
  await loadDevices(); $("settings").hidden = true; toast("Saved");
});
$("btn-lock").addEventListener("click", async () => {
  if (!confirm("Forget the passphrase on this iPhone? You'll need to type it again, and notifications will show no preview until you do.")) return;
  await CS.forgetKey(); key = null; blobs.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: "key-changed" });
  if (channel) sb.removeChannel(channel);
  $("settings").hidden = true; showKeyView("unlock");
});
$("btn-clear").addEventListener("click", async () => {
  if (!confirm("Delete every message and file on all your devices? This can't be undone.")) return;
  try { await CS.deleteAll(sb, me.id); } catch (e) { return toast(e.message); }
  blobs.clear(); $("settings").hidden = true; openChat();
});
$("btn-signout").addEventListener("click", async () => {
  if (!confirm("Sign out of ClipSync on this device?")) return;
  try { if ((await pushState()) === "on") await disablePush(); } catch {}
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut();
  await CS.forgetKey(); key = null; blobs.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: "key-changed" });
  deviceId = null; store.set("deviceId", null);
  $("settings").hidden = true; boot();
});

boot();
