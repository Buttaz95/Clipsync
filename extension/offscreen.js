// Hidden page used only to write received text to the clipboard.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen" || msg.type !== "copy") return;
  const t = document.getElementById("t");
  t.value = msg.text;
  t.select();
  const ok = document.execCommand("copy");
  t.value = "";
  reply({ ok });
});
