/** Egoist Relay shares only the explicitly selected visible post (X only) */
/* global __EGOIST_RELAY_SHARE_LABEL__:readonly */
(function () {
  'use strict';
  const service = '__EGOIST_RELAY_SHARE_SERVICE__';
  const token = '__EGOIST_RELAY_SHARE_TOKEN__';
  let shareLabel = __EGOIST_RELAY_SHARE_LABEL__;
  const postSelector = 'article[data-testid="tweet"]';
  const mediaHosts = ['pbs.twimg.com', 'video.twimg.com'];
  const shareButtons = new WeakSet();
  const activeButtons = new Map();
  let isScheduled = false;
  Object.defineProperty(window, '__egoistRelayIsShareButton', { value: element => shareButtons.has(element), writable: false, configurable: false });

  function getPostUrl(post) {
    const links = Array.from(post.querySelectorAll('a[href]'));
    const selected = links.find(link => link.querySelector('time') && /\/status\/\d+/.test(link.pathname))
      || links.find(link => /\/status\/\d+/.test(link.pathname));
    try {
      const current = new URL(selected?.href || window.location.href);
      if (current.protocol !== 'https:' || !/^(www\.)?(x|twitter)\.com$/i.test(current.hostname)
        || current.username || current.password || (current.port && current.port !== '443')
        || !/^\/[A-Za-z0-9_]+\/status\/\d+$/.test(current.pathname)) return undefined;
      current.search = ''; current.hash = '';
      return current.href;
    } catch { return undefined; }
  }

  function isVisible(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= window.innerHeight
      || bounds.right <= 0 || bounds.left >= window.innerWidth) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }

  function postContext(post) {
    if (!isVisible(post)) return undefined;
    const url = getPostUrl(post);
    if (!url) return undefined;
    return { owner: post, url, mediaRoot: post };
  }

  function hasMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
        && (!url.port || url.port === '443') && value.length <= 4096
        && !/\.(m3u8|mpd)$/i.test(url.pathname)
        && mediaHosts.some(host => url.hostname === host);
    } catch { return false; }
  }

  function selectOriginalPhotoSource(image) {
    const current = hasMediaUrl(image.currentSrc) ? image.currentSrc : image.src;
    const candidates = (image.getAttribute('srcset') || '').split(',').map((entry) => {
      const match = /^(https:\/\/\S+)\s+(\d+(?:\.\d+)?)(w|x)$/.exec(entry.trim());
      if (!match || !hasMediaUrl(match[1])) return undefined;
      const size = Number(match[2]);
      if (!Number.isFinite(size) || size <= 0 || (match[3] === 'w' && !Number.isInteger(size))) return undefined;
      return { url: match[1], size, unit: match[3] };
    }).filter(Boolean);
    if (!candidates.length || candidates.some((candidate) => candidate.unit !== candidates[0].unit)) return current;
    return candidates.reduce((selected, candidate) => candidate.size > selected.size ? candidate : selected).url;
  }

  function collectMedia(post) {
    const media = []; const seen = new Set(); let unavailableMedia = false;
    const videos = post.matches('video') ? [post] : Array.from(post.querySelectorAll('video'));
    videos.forEach(video => {
      const source = video.currentSrc || video.src || video.querySelector('source')?.src;
      if (!source || !hasMediaUrl(source)) { unavailableMedia = true; return; }
      if (!seen.has(source)) { media.push({ url: source, type: 'video' }); seen.add(source); }
    });
    post.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(image => {
      const source = selectOriginalPhotoSource(image);
      const bounds = image.getBoundingClientRect();
      if (bounds.width < 100 || bounds.height < 100 || image.closest('[data-testid="videoPlayer"], video')
        || !hasMediaUrl(source) || seen.has(source)) return;
      const original = new URL(source);
      if (original.hostname === 'pbs.twimg.com' && original.pathname.startsWith('/media/')
        && original.searchParams.has('name')) original.searchParams.set('name', 'orig');
      media.push({ url: original.href, type: 'photo' }); seen.add(source);
    });
    if (media.length > 10) unavailableMedia = true;
    return { media: media.length > 10 ? [] : media, unavailableMedia };
  }

  function requestShare(context, event) {
    if (!event.isTrusted) return;
    event.preventDefault(); event.stopPropagation();
    const current = postContext(context.owner);
    if (!current || !isVisible(current.owner)) return;
    const media = collectMedia(current.mediaRoot);
    const text = current.owner.querySelector('[data-testid="tweetText"]')?.textContent;
    const payload = { requestId: window.crypto.randomUUID(), service, url: current.url, text: text?.slice(0, 4096), media: media.media, unavailableMedia: media.unavailableMedia };
    window.location.href = `egoist-relay-share://request?token=${encodeURIComponent(token)}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  function actionRow(context) {
    return context.owner.querySelector('[role="group"]');
  }

  function makeButton(context) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'egoistRelayShare';
    button.dataset.relayShare = service;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.classList.add('egoistRelayShareIcon');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', 'M21.6 2.4a1 1 0 0 0-1-.2L2.8 9.1c-1 .4-1 1.1-.2 1.4l4.6 1.4L18 5.2c.5-.3.8-.1.4.2l-8.7 7.9-.3 4.6c.5 0 .7-.2 1-.5l2.2-2.1 4.6 3.4c.8.5 1.4.2 1.6-.7L22 3.4c.1-.4 0-.8-.4-1Z');
    icon.appendChild(shape); button.appendChild(icon);
    button.title = shareLabel; button.setAttribute('aria-label', shareLabel);
    button.addEventListener('click', event => requestShare(activeButtons.get(button) || context, event));
    shareButtons.add(button);
    return button;
  }

  function addButtons() {
    isScheduled = false;
    const contexts = new Map();
    document.querySelectorAll(postSelector).forEach(post => {
      const context = postContext(post);
      if (context) contexts.set(post, context);
    });
    const buttonsByOwner = new Map();
    activeButtons.forEach((saved, button) => {
      if (button.isConnected) buttonsByOwner.set(saved.owner, button);
    });
    const used = new Set();
    contexts.forEach((context, key) => {
      const actions = actionRow(context);
      if (!actions) return;
      let button = buttonsByOwner.get(key);
      if (!button) button = makeButton(context);
      activeButtons.set(button, context); used.add(button);
      if (button.parentElement !== actions) actions.appendChild(button);
    });
    activeButtons.forEach((context, button) => {
      if (!used.has(button)) { button.remove(); activeButtons.delete(button); }
    });
  }

  function scheduleButtons() {
    if (isScheduled) return;
    isScheduled = true; window.requestAnimationFrame(addButtons);
  }

  function initialize() {
    if (service !== 'x' || window.top !== window || !token || token.startsWith('__')) return;
    if (window.location.protocol !== 'https:' || !/^(www\.)?(x|twitter)\.com$/i.test(window.location.hostname)
      || window.location.port || window.location.username || window.location.password) return;
    const style = document.createElement('style');
    style.textContent = '.egoistRelayShare{height:2.75rem;width:2.75rem;min-height:2.75rem;min-width:2.75rem;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;padding:0;margin:0;background:transparent;color:inherit;cursor:pointer}.egoistRelayShareIcon{width:1.25rem;height:1.25rem;fill:currentColor}.egoistRelayShare:hover{background:rgba(128,128,128,.14)}.egoistRelayShare:focus-visible{outline:2px solid #3390ec;outline-offset:2px}';
    document.head.appendChild(style);
    addButtons();
    const observer = new MutationObserver(records => {
      if (records.some(record => !shareButtons.has(record.target) && !record.target.closest?.('.egoistRelayShare')
        && (record.type === 'attributes'
          || Array.from(record.addedNodes).some(node => !(node instanceof Element) || !shareButtons.has(node))
          || Array.from(record.removedNodes).some(node => !(node instanceof Element) || !shareButtons.has(node))))) scheduleButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'hidden', 'aria-hidden', 'style', 'class'] });
    window.addEventListener('scroll', scheduleButtons, { passive: true, capture: true });
    window.addEventListener('resize', scheduleButtons, { passive: true });
    window.addEventListener('popstate', scheduleButtons);
    document.addEventListener('loadedmetadata', scheduleButtons, true);
    document.addEventListener('play', scheduleButtons, true);
  }

  window.__egoistRelayUpdateShareLabel = function updateShareLabel(label) {
    if (typeof label !== 'string' || !label.trim() || label.length > 192) return;
    shareLabel = label;
    activeButtons.forEach((context, button) => { button.title = label; button.setAttribute('aria-label', label); });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
