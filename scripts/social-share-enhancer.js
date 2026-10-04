/** Egoist Relay shares only the explicitly selected visible post */
/* global __EGOIST_RELAY_SHARE_LABEL__:readonly */
(function () {
  'use strict';
  const service = '__EGOIST_RELAY_SHARE_SERVICE__';
  const token = '__EGOIST_RELAY_SHARE_TOKEN__';
  let shareLabel = __EGOIST_RELAY_SHARE_LABEL__;
  const postSelector = service === 'x' ? 'article[data-testid="tweet"]' : 'article';
  const mediaHosts = service === 'x' ? ['pbs.twimg.com', 'video.twimg.com'] : ['cdninstagram.com', 'fbcdn.net'];
  const shareButtons = new WeakSet();
  const activeButtons = new Map();
  const reelPresentation = new Map();
  const REEL_ACTION_BOUNDS = { width: 96, height: 80, railWidth: 160, centerTolerance: 12, spacing: 20, ancestorDepth: 6 };
  let isScheduled = false;
  Object.defineProperty(window, '__egoistRelayIsShareButton', { value: element => shareButtons.has(element), writable: false, configurable: false });

  function instagramPostUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'https:' || !/^(www\.)?instagram\.com$/i.test(url.hostname)
        || url.username || url.password || (url.port && url.port !== '443')) return undefined;
      const match = /^\/(?:(?!direct\/|accounts\/|explore\/)([A-Za-z0-9_.]{1,30})\/)?(p|reel|reels)\/([A-Za-z0-9_-]{5,80})\/?$/.exec(url.pathname);
      if (!match || match[1] === '.' || match[1] === '..') return undefined;
      return 'https://www.instagram.com/' + (match[2] === 'reels' ? 'reel' : match[2]) + '/' + match[3] + '/';
    } catch { return undefined; }
  }

  function getPostUrl(post) {
    const links = Array.from(post.querySelectorAll('a[href]'));
    if (service === 'instagram') {
      const timestampUrls = new Set(links.filter(link => link.querySelector('time'))
        .map(link => instagramPostUrl(link.href)).filter(Boolean));
      if (timestampUrls.size) return timestampUrls.size === 1 ? timestampUrls.values().next().value : undefined;
      const urls = new Set(links.map(link => instagramPostUrl(link.href)).filter(Boolean));
      return urls.size === 1 ? urls.values().next().value : undefined;
    }
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

  function visibleVideos(root) {
    return Array.from(root.querySelectorAll('video')).filter(isVisible);
  }

  function reelContext(video) {
    if (!isVisible(video)) return undefined;
    // Stop before a container that combines distinct visible players. A DM preview
    // outside the opened reel never becomes the selected media root.
    let fallback;
    for (let owner = video.parentElement, depth = 0; owner && owner !== document.body && depth < 18; owner = owner.parentElement, depth++) {
      if (visibleVideos(owner).length !== 1) break;
      const url = getPostUrl(owner);
      if (url) return { owner, video, url, mediaRoot: video };
      if (!fallback || owner.matches('article, [role="dialog"]') || owner.querySelector('section')) fallback = owner;
      if (owner.matches('article, [role="dialog"]')) break;
    }
    const current = instagramPostUrl(window.location.href);
    if (!current?.includes('/reel/') || visibleVideos(document).length !== 1 || !fallback) return undefined;
    // A foreign or conflicting permalink must not be hidden by the route fallback.
    const permalinkLinks = Array.from(fallback.querySelectorAll('a[href]'))
      .filter(link => /\/(?:p|reel|reels)\//.test(link.pathname));
    if (permalinkLinks.length && permalinkLinks.some(link => instagramPostUrl(link.href) !== current)) return undefined;
    return { owner: fallback, video, url: current, mediaRoot: video };
  }

  function postContext(post) {
    if (!isVisible(post)) return undefined;
    const url = getPostUrl(post);
    if (!url) return undefined;
    if (service === 'instagram' && post.querySelector('video')) {
      const videos = visibleVideos(post);
      if (!videos.length || (url.includes('/reel/') && videos.length !== 1)) return undefined;
      if (videos.length === 1) return { owner: post, video: videos[0], url, mediaRoot: videos[0] };
    }
    return { owner: post, url, mediaRoot: post };
  }

  function hasMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
        && (!url.port || url.port === '443') && value.length <= 4096
        && !/\.(m3u8|mpd)$/i.test(url.pathname)
        && mediaHosts.some(host => url.hostname === host || (service === 'instagram' && url.hostname.endsWith('.' + host)));
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
    const photos = service === 'x' ? post.querySelectorAll('[data-testid="tweetPhoto"] img') : post.querySelectorAll('img');
    photos.forEach(image => {
      const source = selectOriginalPhotoSource(image);
      const bounds = image.getBoundingClientRect();
      if (bounds.width < 100 || bounds.height < 100 || image.closest('[data-testid="videoPlayer"], video')
        || !hasMediaUrl(source) || seen.has(source)) return;
      if (service === 'instagram' && videos.length) return;
      const original = new URL(source);
      if (service === 'x' && original.hostname === 'pbs.twimg.com' && original.pathname.startsWith('/media/')
        && original.searchParams.has('name')) original.searchParams.set('name', 'orig');
      media.push({ url: original.href, type: 'photo' }); seen.add(source);
    });
    if (media.length > 10) unavailableMedia = true;
    return { media: media.length > 10 ? [] : media, unavailableMedia };
  }

  function requestShare(context, event) {
    if (!event.isTrusted) return;
    event.preventDefault(); event.stopPropagation();
    const current = context.video ? reelContext(context.video) : postContext(context.owner);
    if (!current || !isVisible(current.owner)) return;
    const media = collectMedia(current.mediaRoot);
    const text = service === 'x' ? current.owner.querySelector('[data-testid="tweetText"]')?.textContent : undefined;
    const payload = { requestId: window.crypto.randomUUID(), service, url: current.url, text: text?.slice(0, 4096), media: media.media, unavailableMedia: media.unavailableMedia };
    window.location.href = `egoist-relay-share://request?token=${encodeURIComponent(token)}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  function actionRow(context) {
    if (service === 'x') return context.owner.querySelector('[role="group"]');
    const section = context.owner.querySelector('section');
    if (section && isVisible(section)) return section;
    const nativeShare = Array.from(context.owner.querySelectorAll('[aria-label]'))
      .find(element => /^(Share|Send|Поделиться|Отправить)$/i.test(element.getAttribute('aria-label')) && isVisible(element));
    const control = nativeShare?.closest('button, [role="button"]');
    return control?.parentElement && context.owner.contains(control.parentElement) ? control.parentElement : undefined;
  }

  function getReelActionRail(context) {
    const nativeShare = Array.from(context.owner.querySelectorAll('[aria-label]'))
      .find(element => /^(Share|Send|Поделиться|Отправить)$/i.test(element.getAttribute('aria-label')) && isVisible(element));
    const shareControl = nativeShare?.closest('button, [role="button"]');
    if (!shareControl) return undefined;
    const shareBounds = shareControl.getBoundingClientRect();
    const shareCenter = shareBounds.left + shareBounds.width / 2;
    for (let rail = shareControl.parentElement, depth = 0; rail && context.owner.contains(rail) && depth < REEL_ACTION_BOUNDS.ancestorDepth; rail = rail.parentElement, depth++) {
      const railBounds = rail.getBoundingClientRect();
      const isNarrowColumn = railBounds.width <= REEL_ACTION_BOUNDS.railWidth && getComputedStyle(rail).flexDirection === 'column';
      const controls = Array.from(rail.querySelectorAll('button, [role="button"]')).filter(control => {
        if (shareButtons.has(control) || !isVisible(control)) return false;
        const bounds = control.getBoundingClientRect();
        return bounds.width <= REEL_ACTION_BOUNDS.width && bounds.height <= REEL_ACTION_BOUNDS.height
          && Math.abs(bounds.left + bounds.width / 2 - shareCenter) <= (isNarrowColumn ? railBounds.width : REEL_ACTION_BOUNDS.centerTolerance);
      });
      if (controls.length < 3) continue;
      const centers = controls.map(control => {
        const bounds = control.getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      }).sort((left, right) => left - right);
      if (centers.some((center, index) => index && center - centers[index - 1] < REEL_ACTION_BOUNDS.spacing)) continue;
      const actionNodes = Array.from(rail.children).filter(child => controls.some(control => child.contains(control)));
      const shareAction = actionNodes.find(child => child.contains(shareControl));
      if (actionNodes.length >= 3 && shareAction) return { rail, actionNodes, shareAction };
    }
    return undefined;
  }

  function markReelPresentation(element, className, used) {
    used.add(element);
    if (!reelPresentation.has(element)) {
      const title = element.getAttribute('title') || undefined;
      const hadTitle = element.hasAttribute('title');
      const originalText = element.textContent;
      const appliedText = className === 'egoistRelayReelLabel' && /^Отметки\s+["«]?Нравится["»]?$/i.test(originalText.trim())
        ? 'Нравятся' : undefined;
      if (appliedText) element.textContent = appliedText;
      const appliedTitle = className === 'egoistRelayReelLabel' && !title && element.textContent.trim().length > 12
        ? element.textContent.trim() : undefined;
      reelPresentation.set(element, { className, hadClass: element.classList.contains(className), title, hadTitle, appliedTitle, originalText, appliedText });
      if (appliedTitle) element.title = appliedTitle;
    }
    const saved = reelPresentation.get(element);
    if (saved.appliedText && element.textContent.trim() === saved.originalText.trim()) element.textContent = saved.appliedText;
    if (!element.classList.contains(className)) element.classList.add(className);
  }

  function clearReelPresentation(used) {
    reelPresentation.forEach((saved, element) => {
      if (used.has(element)) return;
      if (!saved.hadClass) element.classList.remove(saved.className);
      if (saved.appliedText && element.textContent === saved.appliedText) element.textContent = saved.originalText;
      if (saved.appliedTitle && element.title === saved.appliedTitle) {
        if (!saved.hadTitle) element.removeAttribute('title');
        else element.setAttribute('title', saved.title || '');
      }
      reelPresentation.delete(element);
    });
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
      if (context) contexts.set(context.video || post, context);
    });
    if (service === 'instagram') {
      document.querySelectorAll('video').forEach(video => {
        if (contexts.has(video)) return;
        const context = reelContext(video);
        if (context) contexts.set(video, context);
      });
    }
    const buttonsByOwner = new Map();
    activeButtons.forEach((saved, button) => {
      if (button.isConnected) buttonsByOwner.set(saved.video || saved.owner, button);
    });
    const used = new Set();
    const usedPresentation = new Set();
    contexts.forEach((context, key) => {
      if (service === 'x' && !actionRow(context)) return;
      let button = buttonsByOwner.get(key);
      if (!button) button = makeButton(context);
      activeButtons.set(button, context); used.add(button);
      const reelRail = service === 'instagram' && context.video ? getReelActionRail(context) : undefined;
      const actions = reelRail?.rail || actionRow(context);
      if (reelRail) {
        markReelPresentation(reelRail.rail, 'egoistRelayReelActions', usedPresentation);
        reelRail.actionNodes.forEach(action => {
          markReelPresentation(action, 'egoistRelayReelAction', usedPresentation);
          action.querySelectorAll('span').forEach(label => {
            if (!label.children.length && label.textContent.trim() && !label.closest('button, [role="button"]')) {
              markReelPresentation(label, 'egoistRelayReelLabel', usedPresentation);
            }
          });
        });
      }
      if (actions) {
        button.classList.remove('egoistRelayShareFloating');
        button.style.removeProperty('left'); button.style.removeProperty('top');
        if (reelRail) {
          if (button.parentElement !== actions || button.previousElementSibling !== reelRail.shareAction) {
            actions.insertBefore(button, reelRail.shareAction.nextSibling);
          }
        } else if (button.parentElement !== actions) actions.appendChild(button);
      } else if (context.video) {
        const bounds = context.video.getBoundingClientRect();
        button.classList.add('egoistRelayShareFloating');
        button.style.left = Math.max(8, Math.min(window.innerWidth - 52, bounds.right - 52)) + 'px';
        button.style.top = Math.max(8, Math.min(window.innerHeight - 52, bounds.bottom - 52)) + 'px';
        if (button.parentElement !== document.body) document.body.appendChild(button);
      } else {
        context.owner.appendChild(button);
      }
    });
    clearReelPresentation(usedPresentation);
    activeButtons.forEach((context, button) => {
      if (!used.has(button)) { button.remove(); activeButtons.delete(button); }
    });
  }

  function scheduleButtons() {
    if (isScheduled) return;
    isScheduled = true; window.requestAnimationFrame(addButtons);
  }

  function initialize() {
    if (window.top !== window || !token || token.startsWith('__')) return;
    const allowed = service === 'x' ? /^(www\.)?(x|twitter)\.com$/i : /^(www\.)?instagram\.com$/i;
    if (window.location.protocol !== 'https:' || !allowed.test(window.location.hostname)
      || window.location.port || window.location.username || window.location.password) return;
    const style = document.createElement('style');
    style.textContent = '.egoistRelayShare{height:2.75rem;width:2.75rem;min-height:2.75rem;min-width:2.75rem;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;padding:0;margin:0;background:transparent;color:inherit;cursor:pointer}.egoistRelayShareIcon{width:1.25rem;height:1.25rem;fill:currentColor}.egoistRelayReelActions{align-items:center!important}.egoistRelayReelAction{display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;align-self:center!important;flex-shrink:0!important;min-inline-size:2.75rem;max-inline-size:100%;text-align:center!important}.egoistRelayReelLabel{display:block;max-inline-size:min(4.5rem,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}.egoistRelayReelActions .egoistRelayShare{align-self:center;flex-shrink:0}.egoistRelayReelActions .egoistRelayShareIcon{width:1.5rem;height:1.5rem}.egoistRelayShare:hover{background:rgba(128,128,128,.14)}.egoistRelayShare:focus-visible{outline:2px solid #3390ec;outline-offset:2px}.egoistRelayShareFloating{position:fixed;z-index:2147483000;background:rgba(20,20,24,.88);color:#fff;box-shadow:0 2px 12px #0005}';
    document.head.appendChild(style);
    addButtons();
    const observer = new MutationObserver(records => {
      if (records.some(record => !shareButtons.has(record.target) && !record.target.closest?.('.egoistRelayShare')
        && (record.type === 'attributes' || (record.type === 'characterData' && reelPresentation.has(record.target.parentElement))
          || Array.from(record.addedNodes).some(node => !(node instanceof Element) || !shareButtons.has(node))
          || Array.from(record.removedNodes).some(node => !(node instanceof Element) || !shareButtons.has(node))))) scheduleButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'src', 'hidden', 'aria-hidden', 'style', 'class'] });
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
