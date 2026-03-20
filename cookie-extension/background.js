const SERVICES = {
  WorkosCursorSessionToken: { domain: "cursor.com", file: "cursor-auth.json" },
  sessionKey: { domain: "claude.ai", file: "claude-auth.json" },
};

function toPlaywrightCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expirationDate || -1,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : "Strict",
  };
}

function saveToFile(fileName, storageState) {
  chrome.runtime.sendNativeMessage(
    "invoice_radar_cookie_host",
    { file: fileName, content: storageState },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(`[invoice-radar] Native messaging error for ${fileName}:`, chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok) {
        console.log(`[invoice-radar] Saved ${fileName} -> ${response.path}`);
      } else {
        console.error(`[invoice-radar] Host error for ${fileName}:`, response);
      }
    }
  );
}

// Listen for cookie changes on tracked domains
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.removed) return;

  const cookie = changeInfo.cookie;
  const svc = SERVICES[cookie.name];
  if (!svc) return;

  console.log(`[invoice-radar] Cookie changed: ${cookie.name} on ${cookie.domain}`);

  const storageState = JSON.stringify(
    { cookies: [toPlaywrightCookie(cookie)], origins: [] },
    null,
    2
  );

  saveToFile(svc.file, storageState);
});

console.log("[invoice-radar] Cookie watcher active");
