const SERVICES = {
  cursor: { domain: "cursor.com", cookieName: "WorkosCursorSessionToken", file: "cursor-auth.json" },
  claude: { domain: "claude.ai", cookieName: "sessionKey", file: "claude-auth.json" },
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

async function exportCookies(serviceKey) {
  const svc = SERVICES[serviceKey];
  const status = document.getElementById("status");

  try {
    const cookies = await chrome.cookies.getAll({ domain: svc.domain });
    const target = cookies.find((c) => c.name === svc.cookieName);

    if (!target) {
      status.className = "error";
      status.textContent = `Cookie "${svc.cookieName}" not found. Log in to ${svc.domain} first.`;
      return;
    }

    const storageState = JSON.stringify(
      { cookies: [toPlaywrightCookie(target)], origins: [] },
      null,
      2
    );

    await navigator.clipboard.writeText(storageState);
    status.className = "success";
    status.textContent = `Copied! Paste into ${svc.file}`;
  } catch (err) {
    status.className = "error";
    status.textContent = `Error: ${err.message}`;
  }
}

document.getElementById("cursor").addEventListener("click", () => exportCookies("cursor"));
document.getElementById("claude").addEventListener("click", () => exportCookies("claude"));
