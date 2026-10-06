const sb = makeClient();
const $ = (id) => document.getElementById(id);

let me = null;            // auth user
let settings = null;      // local settings incl. deviceId
let devices = new Map();  // id -> device row
let channel = null;
let key = null;           // AES key (never leaves this PC)
const shown = new Map();  // message id -> row
const blobs = new Map();  // message id -> decrypted Blob (this session only)
let lastDay = null;

// ---------- helpers ----------
function show(view) {
  for (const v of ["login", "device", "key", "chat"]) $("view-" + v).hidden = v !== view;
}
function toast(text, ms = 1800) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
function targetId() { return $("target").value || null; }
function notifyBackground(type) { chrome.runtime.sendMessage({ type }).catch(() => {}); }

// ---------- startup ----------
async function boot() {
  settings = await getSettings();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show("login");
  me = session.user;

  if (settings.deviceId) {
    const { data } = await sb.from("devices").select("id").eq("id", settings.deviceId).maybeSingle();
    if (!data) { settings.deviceId = null; await chrome.storage.local.remove("deviceId"); }
  }
  if (!settings.deviceId) return show("device");
  if (!(await ensureKey())) return;
  await openChat();
}

// Returns true when this PC holds a working key; otherwise shows the passphrase screen.
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
    ? "Everything you send — text, photos, videos, files — is locked with this before it leaves your device. Supabase only ever stores scrambled data."
    : "Your messages are end-to-end encrypted. Enter the passphrase you set on your first device to unlock this PC.";
  $("key-pass2").hidden = !setup; $("key-pass2").required = setup;
  $("key-pass").autocomplete = setup ? "new-password" : "current-password";
  $("key-submit").textContent = setup ? "Turn on encryption" : "Unlock";
  $("key-warn").textContent = setup
    ? "Write it down somewhere safe. If you forget it, nobody can recover your messages — not even you. You'll enter it once on each device."
    : "";
  $("btn-key-reset").hidden = setup;
  show("key");
  $("key-pass").focus();
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
    notifyBackground("key-changed");
    openChat();
  } catch (err) {
    $("key-error").textContent = err.message || String(err);
    // someone else set it up first -> switch to unlock
    if (mode === "setup" && /duplicate|unique/i.test(err.message || "")) showKeyView("unlock");
  } finally {
    btn.disabled = false; btn.textContent = mode === "setup" ? "Turn on encryption" : "Unlock";
  }
});

$("btn-key-reset").addEventListener("click", async () => {
  if (!confirm("Reset encryption?\n\nThis permanently deletes ALL messages and files on every device, then lets you choose a new passphrase. Your other devices will ask for the new one.")) return;
  if (prompt('Type DELETE to confirm') !== "DELETE") return;
  try { await CS.resetEncryption(sb, me.id); notifyBackground("key-changed"); showKeyView("setup"); toast("Encryption reset"); }
  catch (e) { toast(e.message); }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  const btn = e.submitter; btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
  btn.disabled = false;
  if (error) { $("login-error").textContent = error.message; return; }
  notifyBackground("auth-changed");
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
  notifyBackground("auth-changed");
  if (await ensureKey()) openChat();
});

// ---------- chat ----------
async function loadDevices() {
  const { data } = await sb.from("devices").select("*").order("created_at");
  devices = new Map((data || []).map((d) => [d.id, d]));
  const mine = devices.get(settings.deviceId);
  $("me-label").textContent = mine ? "🔒 " + mine.name : "";
  const sel = $("target"); const prev = sel.value;
  sel.innerHTML = `<option value="">All devices</option>` +
    [...devices.values()].filter((d) => d.id !== settings.deviceId)
      .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function openChat() {
  show("chat");
  setInputH(inputH);
  await loadDevices();
  sb.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", settings.deviceId).then(() => {});

  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) toast(error.message);
  $("messages").innerHTML = ""; shown.clear(); lastDay = null;
  const list = (data || []).reverse().filter(visibleToMe);
  if (!list.length) $("messages").innerHTML = `<div class="empty" id="empty">No messages yet.<br/>Type below, drop files or folders here, or right-click anything on a page and choose <b>Send to ClipSync</b>.<br/><br/>🔒 Everything is end-to-end encrypted.</div>`;
  list.forEach((m) => renderMessage(m));
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
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => {
      if (shown.has(p.new.id)) { shown.set(p.new.id, p.new); fillMessage(document.querySelector(`[data-id="${p.new.id}"]`), p.new); }
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
function nearBottom() { const m = $("messages"); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }

function addDay(when) {
  const day = fmtDay(when);
  if (day !== lastDay) {
    lastDay = day;
    const d = document.createElement("div"); d.className = "day"; d.textContent = day;
    $("messages").appendChild(d);
  }
}

// Insert the shell synchronously (keeps order), then decrypt and fill it in.
function renderMessage(m) {
  if (shown.has(m.id)) return;
  shown.set(m.id, m);
  $("empty")?.remove();
  document.querySelector(`[data-pending-for="${m.id}"]`)?.remove();
  const when = new Date(m.created_at);
  addDay(when);
  const mine = m.sender_device_id === settings.deviceId;
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
    content.innerHTML = `<div class="bubble" title="Click to copy">${linkify(d.text)}</div>`;
    content.querySelector(".bubble").addEventListener("click", (e) => { if (e.target.tagName !== "A") copyText(d.text); });
    act("Copy", () => copyText(d.text));
  } else {
    renderFile(content, act, m, d.file);
  }
  if (m.encrypted === false) acts.insertAdjacentHTML("afterbegin", `<span class="tag" title="Sent before encryption was turned on">unencrypted</span>`);
  act("Delete", async () => {
    try { await CS.deleteMessage(sb, m); el.remove(); shown.delete(m.id); }
    catch (e) { toast(e.message); }
  }, "del");
  if (stick) scrollToBottom();
}

// ---------- files ----------
function renderFile(content, act, m, f) {
  const kind = m.kind;
  const icon = CS.ICON[kind] || "📎";
  const sizeTxt = CS.humanSize(f.size);
  if (f.expired) {
    content.innerHTML = `<div class="file-card expired"><span class="ficon">${icon}</span><div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="small muted">Expired — files are kept for ${CS.FILE_DAYS} days</div></div></div>`;
    return;
  }
  content.innerHTML = `
    <div class="file-card ${kind}">
      <div class="preview"></div>
      <div class="frow"><span class="ficon">${icon}</span>
        <div class="fmeta"><div class="fname" title="${esc(f.name)}">${esc(f.name)}</div><div class="small muted">${sizeTxt}${kind === "folder" ? " · zip" : ""}</div></div></div>
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
  const save = async () => {
    try {
      const b = await get();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = f.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (e) { toast(e.message); }
  };
  const open = async () => {
    try { const b = await get(); chrome.tabs.create({ url: URL.createObjectURL(b) }); }
    catch (e) { toast(e.message); }
  };

  if (kind === "image") {
    const showImg = async () => {
      try {
        const b = await get();
        preview.innerHTML = `<img alt="${esc(f.name)}" />`;
        const img = preview.querySelector("img");
        img.src = URL.createObjectURL(b);
        img.addEventListener("click", open);
        if (nearBottom()) img.addEventListener("load", scrollToBottom, { once: true });
      } catch (e) { preview.innerHTML = `<div class="small muted">Couldn't load: ${esc(e.message)}</div>`; }
    };
    if (f.size <= 15 * 1024 * 1024) showImg();
    else preview.innerHTML = `<button class="ghost small-btn">Show image</button>`, preview.firstChild.addEventListener("click", showImg);
    act("Copy image", async () => {
      try {
        const png = await toPng(await get());
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        toast("Image copied");
      } catch (e) { toast("Couldn't copy image: " + e.message); }
    });
  } else if (kind === "video") {
    preview.innerHTML = `<button class="play">▶ Play video</button>`;
    preview.firstChild.addEventListener("click", async () => {
      try {
        const b = await get();
        preview.innerHTML = `<video controls playsinline></video>`;
        const v = preview.querySelector("video"); v.src = URL.createObjectURL(b); v.play().catch(() => {});
      } catch (e) { toast(e.message); }
    });
  }
  if (kind !== "image" && kind !== "video") act("Open", open);
  act("Save", save);
}

async function toPng(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

// Pending bubble with a progress bar while encrypting + uploading
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

async function sendBlob(blob, { name, type, isFolder } = {}) {
  name = name || blob.name || "file";
  const ui = pendingBubble(name);
  try {
    const row = await CS.sendFile(sb, key, {
      blob, name, type, isFolder, senderId: settings.deviceId, targetId: targetId(), userId: me.id,
      onProgress: (p) => ui.progress(p, `Uploading ${Math.round(p * 100)}% of ${CS.humanSize(blob.size)}`),
    });
    blobs.set(row.id, blob); // we already have it, no need to download our own file
    ui.el.remove();
    renderMessage(row);
  } catch (e) { ui.fail(e.message || String(e)); }
}

async function sendFolder(entries, folderName) {
  if (!entries.length) return toast("That folder is empty");
  const ui = pendingBubble(folderName + ".zip");
  let zip;
  try { zip = await CS.zipEntries(entries, (p) => ui.progress(p, `Zipping ${Math.round(p * 100)}%`)); }
  catch (e) { return ui.fail(e.message); }
  ui.el.remove();
  await sendBlob(zip, { name: folderName + ".zip", type: "application/zip", isFolder: true });
}

async function sendText(text) {
  text = text.replace(/\s+$/, "");
  if (!text.trim()) return;
  try {
    const row = await CS.sendText(sb, key, { text, senderId: settings.deviceId, targetId: targetId() });
    renderMessage(row); scrollToBottom();
    return true;
  } catch (e) { toast("Not sent: " + e.message); return false; }
}

// ---------- composer ----------
const input = $("input");
function autosize() {} // the box keeps the size you dragged it to

// Resizable message box: drag the top edge of the composer
const INPUT_DEFAULT = 120, INPUT_MIN = 56;
let inputH = INPUT_DEFAULT;
function maxInputH() {
  const other = document.querySelector(".topbar").offsetHeight + $("composer").offsetHeight - input.offsetHeight;
  return Math.max(INPUT_MIN, window.innerHeight - other - 90);
}
function setInputH(h, save) {
  inputH = Math.round(Math.min(Math.max(h, INPUT_MIN), maxInputH()));
  document.documentElement.style.setProperty("--input-h", inputH + "px");
  if (save) chrome.storage.local.set({ inputHeight: inputH });
}
chrome.storage.local.get("inputHeight").then((r) => setInputH(r.inputHeight || INPUT_DEFAULT));
window.addEventListener("resize", () => setInputH(inputH));

const resizer = $("resizer");
resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const startY = e.clientY, startH = input.offsetHeight;
  const stick = nearBottom();
  resizer.classList.add("dragging"); document.body.classList.add("resizing");
  const move = (ev) => { setInputH(startH + (startY - ev.clientY)); if (stick) scrollToBottom(); };
  const up = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.classList.remove("dragging"); document.body.classList.remove("resizing");
    setInputH(inputH, true);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up, { once: true });
  resizer.addEventListener("pointercancel", up, { once: true });
});
resizer.addEventListener("dblclick", () => setInputH(INPUT_DEFAULT, true));
resizer.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault(); setInputH(inputH + (e.key === "ArrowUp" ? 20 : -20), true);
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("btn-send").click(); }
});
// Ctrl+V a screenshot / copied file straight into the box sends it
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f) => sendBlob(f, { name: f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png` }));
});
$("btn-send").addEventListener("click", async () => {
  const v = input.value;
  if (!v.trim()) return;
  input.value = "";
  const ok = await sendText(v);
  if (ok === false) input.value = v;
  input.focus();
});
$("btn-paste").addEventListener("click", async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const img = it.types.find((t) => t.startsWith("image/"));
      if (img) { const b = await it.getType(img); return sendBlob(b, { name: `pasted-${Date.now()}.${img.split("/")[1]}`, type: img }); }
    }
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast("Clipboard is empty");
    if (await sendText(t)) toast("Sent from clipboard");
  } catch { toast("Couldn't read the clipboard"); }
});
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("btn-folder").addEventListener("click", () => $("folder-input").click());
$("file-input").addEventListener("change", (e) => { [...e.target.files].forEach((f) => sendBlob(f)); e.target.value = ""; });
$("folder-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const name = files[0].webkitRelativePath.split("/")[0] || "folder";
  sendFolder(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })), name);
  e.target.value = "";
});

// Drag and drop: files, folders, or text/links dragged from a page
let dragDepth = 0;
const chatView = $("view-chat");
chatView.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").hidden = false; });
chatView.addEventListener("dragover", (e) => e.preventDefault());
chatView.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
chatView.addEventListener("drop", async (e) => {
  e.preventDefault(); dragDepth = 0; $("drop").hidden = true;
  const dt = e.dataTransfer;
  const entries = [...dt.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) {
    for (const en of entries) {
      if (en.isDirectory) sendFolder(await CS.readDroppedEntry(en), en.name);
      else en.file((f) => sendBlob(f));
    }
    return;
  }
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text && text.trim()) sendText(text);
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
$("btn-lock").addEventListener("click", async () => {
  if (!confirm("Forget the passphrase on this PC? You'll need to type it again to read messages here.")) return;
  await CS.forgetKey(); key = null; blobs.clear();
  notifyBackground("key-changed");
  if (channel) sb.removeChannel(channel);
  $("settings").hidden = true; showKeyView("unlock");
});
$("btn-clear").addEventListener("click", async () => {
  if (!confirm("Delete every message and file on all your devices? This can't be undone.")) return;
  try { await CS.deleteAll(sb, me.id); } catch (e) { return toast(e.message); }
  blobs.clear(); $("settings").hidden = true; openChat();
});
$("btn-signout").addEventListener("click", async () => {
  if (!confirm("Sign out of ClipSync on this PC?")) return;
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut();
  await CS.forgetKey(); key = null; blobs.clear();
  await chrome.storage.local.remove(["deviceId", "deviceName"]);
  notifyBackground("auth-changed");
  $("settings").hidden = true; show("login");
});

// right-click sends happen in the background; show them here too
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "sent" && msg.row && settings?.deviceId && key) { renderMessage(msg.row); scrollToBottom(); }
});

boot();
