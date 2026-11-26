(() => {
  "use strict";

  if (window.top !== window) return;

  const publicHosts = new Set(["t.me", "telegram.me", "telegram.dog"]);
  const blockedRoutes = new Set([
    "auth", "authorize", "confirmphone", "credential", "credentials", "login",
    "oauth", "passport", "proxy", "socks", "telegrampassport", "webproxy",
  ]);
  const reservedSubdomains = new Set([
    ...blockedRoutes,
    "addemoji", "addlist", "addstickers", "addstyle", "addtheme", "auction",
    "boost", "call", "contact", "giftcode", "invoice", "joinchat", "nft",
    "setlanguage", "share", "web", "www",
  ]);

  function supportedUrl(href) {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;

    if (url.hostname === "web.telegram.org") {
      if (!/^\/[akz]\/?$/.test(url.pathname)) return null;
      for (const [name, value] of url.searchParams) {
        if (name !== "account" || !/^\d{1,3}$/.test(value)) return null;
      }
      // Веб-клиент передаёт данные входа во фрагменте. Разрешаем только адрес чата или сообщения.
      if (url.hash && !/^#(?:@[a-z\d_]{1,32}|-?\d{1,20})(?:[/_]\d{1,10})?$/i.test(url.hash)) {
        return null;
      }
      return url.href;
    }

    const isPublicHost = publicHosts.has(url.hostname);
    if (!isPublicHost) {
      const subdomain = /^([a-z][a-z\d_]{2,30}[a-z\d])\.t\.me$/.exec(url.hostname)?.[1];
      if (!subdomain || subdomain.includes("__") || reservedSubdomains.has(subdomain)) return null;
    }

    let route;
    try {
      // Telegram обрабатывает /s/ как префикс предпросмотра публичной ссылки.
      route = decodeURIComponent(url.pathname).replace(/^\/+(?:s\/+)*/i, "").split(/[/?#;]/, 1)[0].toLowerCase();
    } catch {
      return null;
    }
    if ((isPublicHost && !route) || blockedRoutes.has(route) || /[%\\\s]/.test(route)) {
      return null;
    }

    for (const name of url.searchParams.keys()) {
      const field = name.toLowerCase().replace(/[^a-z\d]/g, "");
      if (name.includes("%") || /auth|credential|login|token|password|passwd|passcode|session|tgwebappdata/.test(field)
          || /^(code|pass|pwd|hash|signature|secret|cookie)$/.test(field)) {
        return null;
      }
    }

    // Публичные ссылки Telegram не используют фрагмент.
    url.hash = "";
    return url.href;
  }

  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = new CSSStyleSheet();
  style.replaceSync(`
    :host {
      all: initial !important;
      position: fixed !important;
      left: max(12px, env(safe-area-inset-left)) !important;
      bottom: max(12px, env(safe-area-inset-bottom)) !important;
      z-index: 2147483647 !important;
    }
    :host([hidden]) {
      display: none !important;
    }
    button {
      appearance: none;
      min-height: 36px;
      padding: 0 12px;
      border: 1px solid #646460;
      border-radius: 8px;
      background: #242425;
      color: #f5f5f2;
      font: 600 13px/1.3 system-ui, sans-serif;
      cursor: pointer;
      transition: background-color 160ms ease-out;
    }
    button:hover {
      background: #383839;
    }
    button:focus-visible {
      outline: 2px solid #f5f5f2;
      outline-offset: -4px;
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  `);
  shadow.adoptedStyleSheets = [style];

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Открыть в Бересте";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!event.isTrusted) return;

    const url = supportedUrl(window.location.href);
    if (url) window.location.assign(`beresta://open?url=${encodeURIComponent(url)}`);
  });
  shadow.append(button);

  function updateVisibility() {
    host.hidden = !supportedUrl(window.location.href);
  }

  updateVisibility();
  document.body.append(host);

  window.navigation?.addEventListener("currententrychange", updateVisibility);
  window.addEventListener("hashchange", updateVisibility);
  window.addEventListener("popstate", updateVisibility);
})();
