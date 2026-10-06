const sb = makeClient();
const $ = (id) => document.getElementById(id);

let me = null;            // auth user
let settings = null;      // local settings incl. deviceId
let devices = new Map();  // id -> device row
let channel = null;
const shown = new Set();  // message ids already rendered
let lastDay = null;

// ---------- helpers ----------
function show(view) {
  for (const v of ["login", "device", "chat"]) $("view-" + v).hidden = v !== view;
}
function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1600);
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function linkify(s) {
  return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function fmtTime(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDay(d) {
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast("Copied");
}
function visibleToMe(m) {
  return !m.target_device_id || m.target_device_id === settings.deviceId || m.sender_device_id === settings.deviceId;
}

// ---------- startup ----------
async function boot() {
  settings = await getSettings();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show("login");
  me = session.user;

  // Make sure this device is still registered
  if (settings.deviceId) {
    const { data } = await sb.from("devices").select("id").eq("id", settings.deviceId).maybeSingle();
    if (!data) { settings.deviceId = null; await chrome.storage.local.remove("deviceId"); }
  }
  if (!settings.deviceId) return show("device");
  await openChat();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const btn = e.submitter; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
  btn.disabled = false;
  if (error) { $("login-error").textContent = error.message; return; }
  chrome.runtime.sendMessage({ type: "auth-changed" }).catch(() => {});
  boot();
});

$("device-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("device-name").value.trim();
  if (!name) return;
  const { data, error } = await sb.from("devices").insert({ name, platform: "edge" }).select().single();
  if (error) { $("device-error").textContent = error.message; return; }
  await chrome.storage.local.set({ deviceId: data.id, deviceName: data.name });
  settings.deviceId = data.id; settings.deviceName = data.name;
  chrome.runtime.sendMessage({ type: "auth-changed" }).catch(() => {});
  openChat();
});

// ---------- chat ----------
async function loadDevices() {
  const { data } = await sb.from("devices").select("*").order("created_at");
  devices = new Map((data || []).map((d) => [d.id, d]));
  const mine = devices.get(settings.deviceId);
  $("me-label").textContent = mine ? "This device: " + mine.name : "";
  const sel = $("target"); const prev = sel.value;
  sel.innerHTML = `<option value="">All devices</option>` +
    [...devices.values()].filter((d) => d.id !== settings.deviceId)
      .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function openChat() {
  show("chat");
  await loadDevices();
  sb.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", settings.deviceId).then(() => {});

  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) toast(error.message);
  $("messages").innerHTML = ""; shown.clear(); lastDay = null;
  const list = (data || []).reverse().filter(visibleToMe);
  if (!list.length) $("messages").innerHTML = `<div class="empty" id="empty">No messages yet.<br/>Type below, or right-click any text on a page and choose <b>Send to ClipSync</b>.</div>`;
  list.forEach(renderMessage);
  scrollToBottom();
  subscribe();
  $("input").focus();
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("panel-" + settings.deviceId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
      if (visibleToMe(p.new)) { renderMessage(p.new); scrollToBottom(); }
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => {
      document.querySelector(`[data-id="${p.old.id}"]`)?.remove();
      shown.delete(p.old.id);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => loadDevices())
    .subscribe((status) => {
      const dot = $("status-dot");
      dot.className = "dot " + (status === "SUBSCRIBED" ? "live" : status === "CLOSED" || status === "CHANNEL_ERROR" ? "down" : "");
      dot.title = status === "SUBSCRIBED" ? "Live" : status;
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
    const d = document.createElement("div"); d.className = "day"; d.textContent = day;
    $("messages").appendChild(d);
  }
  const mine = m.sender_device_id === settings.deviceId;
  const from = devices.get(m.sender_device_id)?.name || "Removed device";
  const to = m.target_device_id ? " → " + (devices.get(m.target_device_id)?.name || "device") : "";
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "mine" : "theirs");
  el.dataset.id = m.id;
  const text = m.body || (m.file_name ? `📎 ${m.file_name} (files arrive in the next update)` : "");
  el.innerHTML = `
    <div class="bubble" title="Click to copy">${linkify(text)}</div>
    <div class="meta"><span>${mine ? "You" : esc(from)}${esc(to)} · ${fmtTime(when)}</span>
      <button data-act="copy">Copy</button><button data-act="del">Delete</button></div>`;
  el.querySelector(".bubble").addEventListener("click", (e) => { if (e.target.tagName !== "A") copyText(m.body || ""); });
  el.querySelector('[data-act="copy"]').addEventListener("click", () => copyText(m.body || ""));
  el.querySelector('[data-act="del"]').addEventListener("click", async () => {
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) return toast(error.message);
    el.remove(); shown.delete(m.id);
  });
  $("messages").appendChild(el);
}

async function sendText(text) {
  text = text.replace(/\s+$/, "");
  if (!text.trim()) return;
  const target = $("target").value || null;
  const { data, error } = await sb.from("messages")
    .insert({ kind: kindFor(text), body: text, sender_device_id: settings.deviceId, target_device_id: target })
    .select().single();
  if (error) { toast("Not sent: " + error.message); return false; }
  renderMessage(data); scrollToBottom();
  return true;
}

// composer
const input = $("input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("btn-send").click(); }
});
$("btn-send").addEventListener("click", async () => {
  const v = input.value;
  if (!v.trim()) return;
  input.value = ""; autosize();
  const ok = await sendText(v);
  if (ok === false) { input.value = v; autosize(); }
  input.focus();
});
$("btn-paste").addEventListener("click", async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast("Clipboard has no text");
    if (await sendText(t)) toast("Sent from clipboard");
  } catch { toast("Couldn't read the clipboard"); }
});

// ---------- settings ----------
$("btn-settings").addEventListener("click", async () => {
  await loadDevices();
  $("set-name").value = devices.get(settings.deviceId)?.name || "";
  $("set-autocopy").checked = settings.autoCopy;
  $("set-notify").checked = settings.notify;
  $("device-list").innerHTML = [...devices.values()].map((d) => `
    <li><span>${esc(d.name)} <span class="muted small">${d.platform}${d.id === settings.deviceId ? " · this one" : ""}</span></span>
    ${d.id === settings.deviceId ? "" : `<button class="ghost danger" data-remove="${d.id}">Remove</button>`}</li>`).join("");
  $("device-list").querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this device? If it is still in use it will ask for a new name next time it opens.")) return;
    await sb.from("devices").delete().eq("id", b.dataset.remove);
    b.closest("li").remove(); loadDevices();
  }));
  $("settings").hidden = false;
});
$("btn-close-settings").addEventListener("click", () => ($("settings").hidden = true));
$("settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("settings").hidden = true; });
$("btn-save-settings").addEventListener("click", async () => {
  const name = $("set-name").value.trim();
  if (name && name !== devices.get(settings.deviceId)?.name) {
    await sb.from("devices").update({ name }).eq("id", settings.deviceId);
    await chrome.storage.local.set({ deviceName: name });
  }
  settings.autoCopy = $("set-autocopy").checked;
  settings.notify = $("set-notify").checked;
  await chrome.storage.local.set({ autoCopy: settings.autoCopy, notify: settings.notify });
  await loadDevices();
  $("settings").hidden = true; toast("Saved");
});
$("btn-clear").addEventListener("click", async () => {
  if (!confirm("Delete every message on all your devices? This can't be undone.")) return;
  const { error } = await sb.from("messages").delete().eq("user_id", me.id);
  if (error) return toast(error.message);
  $("settings").hidden = true; openChat();
});
$("btn-signout").addEventListener("click", async () => {
  if (!confirm("Sign out of ClipSync on this PC?")) return;
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut();
  await chrome.storage.local.remove(["deviceId", "deviceName"]);
  chrome.runtime.sendMessage({ type: "auth-changed" }).catch(() => {});
  $("settings").hidden = true; show("login");
});

// context-menu sends happen in the background; refresh if the panel missed them
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "sent" && msg.row && settings?.deviceId) { renderMessage(msg.row); scrollToBottom(); }
});

boot();
