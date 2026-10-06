// ClipSync iPhone web app
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
const shown = new Set();
let lastDay = null;
let openId = new URLSearchParams(location.search).get("open");

const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ---------- helpers ----------
function show(view) { for (const v of ["login", "device", "chat"]) $("view-" + v).hidden = v !== view; }
function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1600);
}
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); }
function kindFor(text) { return /^https?:\/\/\S+$/i.test(text.trim()) ? "link" : "text"; }
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
    // Fallback for older iOS
    const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy"); ta.remove(); toast(ok ? "Copied" : "Couldn't copy");
  }
}
function visibleToMe(m) { return !m.target_device_id || m.target_device_id === deviceId || m.sender_device_id === deviceId; }
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
  openChat();
}

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
  openChat();
});

// ---------- chat ----------
async function loadDevices() {
  const { data } = await sb.from("devices").select("*").order("created_at");
  devices = new Map((data || []).map((d) => [d.id, d]));
  $("me-label").textContent = devices.get(deviceId) ? "This device: " + devices.get(deviceId).name : "";
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
  if (!list.length) $("messages").innerHTML = `<div class="empty" id="empty">No messages yet.<br/>Type below, or tap <b>Paste &amp; send</b> to send what you copied.</div>`;
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

function renderMessage(m) {
  if (shown.has(m.id)) return;
  shown.add(m.id);
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
  const text = m.body || (m.file_name ? `📎 ${m.file_name} (files arrive in the next update)` : "");
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "mine" : "theirs");
  el.dataset.id = m.id;
  el.innerHTML = `
    <div class="bubble">${linkify(text)}</div>
    <div class="meta"><span>${mine ? "You" : esc(from)}${esc(to)} · ${fmtTime(when)}</span>
      <button data-act="copy">Copy</button>${navigator.share ? '<button data-act="share">Share</button>' : ""}<button data-act="del" class="del">Delete</button></div>`;
  el.querySelector('[data-act="copy"]').addEventListener("click", () => copyText(m.body || ""));
  el.querySelector('[data-act="share"]')?.addEventListener("click", () => navigator.share({ text: m.body || "" }).catch(() => {}));
  el.querySelector('[data-act="del"]').addEventListener("click", async () => {
    if (!confirm("Delete this message on all devices?")) return;
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) return toast(error.message);
    el.remove(); shown.delete(m.id);
  });
  $("messages").appendChild(el);
}

function focusOpened() {
  if (!openId) return;
  const el = document.querySelector(`[data-id="${openId}"]`);
  if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); }
  openId = null;
  history.replaceState(null, "", location.pathname);
}

function clearBadge() {
  navigator.clearAppBadge?.().catch(() => {});
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-badge" });
}

async function sendText(text) {
  text = text.replace(/\s+$/, "");
  if (!text.trim()) return;
  const target = $("target").value || null;
  const { data, error } = await sb.from("messages")
    .insert({ kind: kindFor(text), body: text, sender_device_id: deviceId, target_device_id: target })
    .select().single();
  if (error) { toast("Not sent: " + error.message); return false; }
  renderMessage(data); scrollToBottom();
  return true;
}

const input = $("input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  // On iPhone the Return key adds a new line; tap the send button to send.
  if (!isIOS && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("btn-send").click(); }
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
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast("Clipboard has no text");
    if (await sendText(t)) toast("Sent from clipboard");
  } catch { toast("Paste was blocked — long-press the message box and tap Paste instead"); }
});

// Catch up when the app comes back to the foreground (iOS pauses it in the background)
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !deviceId || $("view-chat").hidden) return;
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
$("btn-clear").addEventListener("click", async () => {
  if (!confirm("Delete every message on all your devices? This can't be undone.")) return;
  const { error } = await sb.from("messages").delete().eq("user_id", me.id);
  if (error) return toast(error.message);
  $("settings").hidden = true; openChat();
});
$("btn-signout").addEventListener("click", async () => {
  if (!confirm("Sign out of ClipSync on this device?")) return;
  try { if ((await pushState()) === "on") await disablePush(); } catch {}
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut();
  deviceId = null; store.set("deviceId", null);
  $("settings").hidden = true; boot();
});

boot();
