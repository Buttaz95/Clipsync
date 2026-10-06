// Shared by the side panel and the background worker.
const CLIPSYNC = {
  url: "https://aaxtchjpfiawlybsaqmi.supabase.co",
  key: "sb_publishable_pFIvQdq9RDFO-TUpvYlH3w_0xUBZpp7",
};

// supabase-js normally uses localStorage, which the background worker doesn't have.
// chrome.storage.local works everywhere in the extension, so the login is shared.
const chromeStorageAdapter = {
  async getItem(k) { const r = await chrome.storage.local.get(k); return r[k] ?? null; },
  async setItem(k, v) { await chrome.storage.local.set({ [k]: v }); },
  async removeItem(k) { await chrome.storage.local.remove(k); },
};

function makeClient() {
  return supabase.createClient(CLIPSYNC.url, CLIPSYNC.key, {
    auth: { storage: chromeStorageAdapter, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

async function getSettings() {
  const d = { deviceId: null, deviceName: null, autoCopy: true, notify: true };
  const r = await chrome.storage.local.get(["deviceId", "deviceName", "autoCopy", "notify"]);
  return { ...d, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) };
}

function kindFor(text) {
  return /^https?:\/\/\S+$/i.test(text.trim()) ? "link" : "text";
}
