// Background worker: right-click menu, notifications and auto-copy for incoming messages.
importScripts("lib/supabase.js", "lib/cs-core.js", "common.js");

const sb = makeClient();
let channel = null;
const notified = new Map(); // notificationId -> text

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- right-click menu ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "send-selection", title: "Send “%s” to ClipSync", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "send-link", title: "Send link to ClipSync", contexts: ["link"] });
    chrome.contextMenus.create({ id: "send-image", title: "Send image to ClipSync", contexts: ["image"] });
    chrome.contextMenus.create({ id: "send-media", title: "Send this video/audio to ClipSync", contexts: ["video", "audio"] });
    chrome.contextMenus.create({ id: "send-page", title: "Send this page to ClipSync", contexts: ["page"] });
  });
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
});

async function ready() {
  const s = await getSettings();
  const { data: { session } } = await sb.auth.getSession();
  const key = await CS.loadKey();
  if (!session || !s.deviceId) { note("Not signed in", "Click the ClipSync icon to sign in first."); return null; }
  if (!key) { note("ClipSync is locked", "Open ClipSync and enter your passphrase first."); return null; }
  return { s, session, key };
}

function badge(text) {
  chrome.action.setBadgeText({ text });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
}

function nameFromUrl(url, type) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(-80);
  } catch {}
  const ext = (type || "").split("/")[1]?.split(";")[0] || "bin";
  return `download-${Date.now()}.${ext.replace("jpeg", "jpg")}`;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const ctx = await ready();
  if (!ctx) return;
  try {
    let row;
    if (info.menuItemId === "send-image" || info.menuItemId === "send-media") {
      // Download the actual image/video and send it as an encrypted file. Falls back to the link.
      badge("…");
      try {
        const res = await fetch(info.srcUrl);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        row = await CS.sendFile(sb, ctx.key, {
          blob, name: nameFromUrl(info.srcUrl, blob.type), type: blob.type,
          senderId: ctx.s.deviceId, userId: ctx.session.user.id,
        });
      } catch (e) {
        if (info.srcUrl.startsWith("blob:") || info.srcUrl.startsWith("data:") && info.srcUrl.length > 100000) throw e;
        row = await CS.sendText(sb, ctx.key, { text: info.srcUrl, senderId: ctx.s.deviceId });
        note("Sent as a link", "Couldn't download that file (" + (e.message || e) + "), so its link was sent instead.");
      }
    } else {
      const text =
        info.menuItemId === "send-selection" ? info.selectionText :
        info.menuItemId === "send-link" ? info.linkUrl :
        info.menuItemId === "send-page" ? tab?.url : null;
      if (!text) return;
      row = await CS.sendText(sb, ctx.key, { text, senderId: ctx.s.deviceId });
    }
    chrome.runtime.sendMessage({ type: "sent", row }).catch(() => {});
    badge("✓");
  } catch (e) {
    badge("");
    note("Not sent", e.message || String(e));
  }
});

// ---------- incoming messages ----------
async function connect() {
  const s = await getSettings();
  const { data: { session } } = await sb.auth.getSession();
  if (channel) { await sb.removeChannel(channel); channel = null; }
  if (!session || !s.deviceId) return;
  sb.realtime.setAuth(session.access_token);
  channel = sb.channel("bg-" + s.deviceId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => onIncoming(p.new))
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") channel = null;
    });
}

async function onIncoming(m) {
  const s = await getSettings();
  if (m.sender_device_id === s.deviceId) return;
  if (m.target_device_id && m.target_device_id !== s.deviceId) return;
  const { data: dev } = await sb.from("devices").select("name").eq("id", m.sender_device_id).maybeSingle();
  const from = dev?.name || "another device";
  const key = await CS.loadKey();
  const d = await CS.decodeMessage(key, m);

  let body, copyable = null;
  if (d.locked) body = "🔒 New encrypted message — open ClipSync to unlock";
  else if (d.file) body = `${CS.ICON[m.kind] || "📎"} ${d.file.name} (${CS.humanSize(d.file.size)})`;
  else { body = d.text; copyable = d.text; }

  let copied = false;
  if (s.autoCopy && copyable) copied = await copyToClipboard(copyable);
  if (s.notify) {
    const id = await note(`From ${from}${copied ? " · copied" : ""}`, body.slice(0, 250) || "(empty)");
    if (copyable) notified.set(id, copyable);
  }
}

function note(title, message) {
  return new Promise((res) =>
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 }, res));
}

chrome.notifications.onClicked.addListener(async (id) => {
  const text = notified.get(id);
  if (text) await copyToClipboard(text);
  chrome.notifications.clear(id);
  notified.delete(id);
});

// The worker can't touch the clipboard directly, so a hidden offscreen page does it.
async function copyToClipboard(text) {
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Copy received ClipSync text",
      });
    }
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text });
    return !!r?.ok;
  } catch (e) {
    console.warn("copy failed", e);
    return false;
  }
}

// ---------- keep connected ----------
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "keepalive" && !channel) connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "auth-changed") connect();
  if (msg.type === "key-changed") CS.resetCache();
});
sb.auth.onAuthStateChange((event) => { if (event === "TOKEN_REFRESHED" || event === "SIGNED_OUT") connect(); });
chrome.alarms.get("keepalive", (a) => { if (!a) chrome.alarms.create("keepalive", { periodInMinutes: 1 }); });
connect();
