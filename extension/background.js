// Background worker: right-click menu, notifications and auto-copy for incoming messages.
importScripts("lib/supabase.js", "common.js");

const sb = makeClient();
let channel = null;
const notified = new Map(); // notificationId -> text

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- right-click menu ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "send-selection", title: "Send “%s” to ClipSync", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "send-link", title: "Send link to ClipSync", contexts: ["link"] });
    chrome.contextMenus.create({ id: "send-image", title: "Send image link to ClipSync", contexts: ["image"] });
    chrome.contextMenus.create({ id: "send-page", title: "Send this page to ClipSync", contexts: ["page"] });
  });
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text =
    info.menuItemId === "send-selection" ? info.selectionText :
    info.menuItemId === "send-link" ? info.linkUrl :
    info.menuItemId === "send-image" ? info.srcUrl :
    info.menuItemId === "send-page" ? tab?.url : null;
  if (!text) return;
  const s = await getSettings();
  const { data: { session } } = await sb.auth.getSession();
  if (!session || !s.deviceId) {
    return note("Not signed in", "Click the ClipSync icon to sign in first.");
  }
  const { data, error } = await sb.from("messages")
    .insert({ kind: kindFor(text), body: text, sender_device_id: s.deviceId })
    .select().single();
  if (error) return note("Not sent", error.message);
  chrome.runtime.sendMessage({ type: "sent", row: data }).catch(() => {});
  chrome.action.setBadgeText({ text: "✓" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
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
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        channel = null; // the keepalive alarm reconnects
      }
    });
}

async function onIncoming(m) {
  const s = await getSettings();
  if (m.sender_device_id === s.deviceId) return;                       // my own message
  if (m.target_device_id && m.target_device_id !== s.deviceId) return; // meant for another device
  const { data: dev } = await sb.from("devices").select("name").eq("id", m.sender_device_id).maybeSingle();
  const from = dev?.name || "another device";
  const text = m.body || (m.file_name ? "📎 " + m.file_name : "");

  let copied = false;
  if (s.autoCopy && m.body) copied = await copyToClipboard(m.body);
  if (s.notify) {
    const id = await note(`From ${from}${copied ? " · copied" : ""}`, text.slice(0, 250) || "(empty)");
    if (m.body) notified.set(id, m.body);
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
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "auth-changed") connect(); });
sb.auth.onAuthStateChange((event) => { if (event === "TOKEN_REFRESHED" || event === "SIGNED_OUT") connect(); });
chrome.alarms.get("keepalive", (a) => { if (!a) chrome.alarms.create("keepalive", { periodInMinutes: 1 }); });
connect();
