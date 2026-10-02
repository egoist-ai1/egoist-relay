(function () {
  'use strict';

  if (window.top !== window || window.__egoistSocialResearch) return;
  const provider = /^(www\.)?(x|twitter)\.com$/.test(location.hostname) ? 'x'
    : /^(www\.)?instagram\.com$/.test(location.hostname) ? 'instagram' : undefined;
  if (!provider || location.protocol !== 'https:') return;
  const now = Date.now.bind(Date);
  const MAX_CHUNK = 49152;
  const MAX_FILE = 1073741824;
  const MAX_JOB_MEDIA = 2147483648;
  const MAX_MEDIA_FILES = 500;
  const MAX_FRAME = 73728;
  const DOM_READY_WAIT_MS = 15000;
  const DOM_POLL_INTERVAL_MS = 150;
  const encoder = new TextEncoder();
  let active;

  function failure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function guard(job) {
    if (active !== job || job.controller.signal.aborted) throw failure(job.abortCode || 'CANCELLED');
    if (now() >= job.expires) throw failure('DEADLINE');
  }

  async function pause(job, milliseconds) {
    guard(job);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(milliseconds, Math.max(1, job.expires - now())));
      job.controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(failure(job.abortCode || 'CANCELLED'));
      }, { once: true });
    });
    guard(job);
  }

  function absolute(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return undefined;
      return url.href;
    } catch { return undefined; }
  }

  function canonical(value) {
    const resolved = absolute(value);
    if (!resolved) return undefined;
    const url = new URL(resolved);
    const valid = provider === 'x' ? /^(www\.)?(x|twitter)\.com$/.test(url.hostname)
      : /^(www\.)?instagram\.com$/.test(url.hostname);
    if (!valid) return undefined;
    url.hostname = provider === 'x' ? 'x.com' : 'www.instagram.com';
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  }

  // One strict locator is shared by dispatch, eligibility and page-caption provenance.
  // Optional handles are URL aliases, never evidence of a publisher identity.
  function instagramPostLocator(value) {
    if (provider !== 'instagram') return undefined;
    const source = canonical(value);
    if (!source) return undefined;
    const parts = new URL(source).pathname.slice(1).split('/');
    let kind;
    let shortcode;
    if (parts.length === 2) [kind, shortcode] = parts;
    else if (parts.length === 3) {
      const handle = parts[0].toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(handle) || [
        'home', 'search', 'explore', 'reels', 'accounts', 'direct', 'messages', 'i', 'settings',
        'login', 'p', 'reel',
      ].includes(handle)) return undefined;
      [, kind, shortcode] = parts;
    } else return undefined;
    if (!['p', 'reel', 'reels'].includes(kind)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(shortcode)) return undefined;
    return { kind: kind === 'reels' ? 'reel' : kind, shortcode };
  }

  function sameInstagramPost(left, right) {
    const a = instagramPostLocator(left), b = instagramPostLocator(right);
    return Boolean(a && b && a.kind === b.kind && a.shortcode === b.shortcode);
  }

  function isCdn(value) {
    const resolved = absolute(value);
    if (!resolved) return false;
    const host = new URL(resolved).hostname.toLowerCase();
    return provider === 'x' ? ['pbs.twimg.com', 'video.twimg.com'].includes(host)
      : host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net');
  }

  function text(node) { return node?.innerText || node?.textContent || undefined; }
  function meta(name) { return document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || undefined; }

  function authProof() {
    const path = location.pathname;
    if (/\/(challenge|checkpoint)(\/|$)/.test(path)
      || document.querySelector('iframe[src*="arkoselabs"],iframe[src*="recaptcha"],[data-testid="challenge"]')) {
      return { state: 'challenge_required', reason: 'CHALLENGE_REQUIRED' };
    }
    if (/\/(i\/flow\/login|accounts\/login)(\/|$)/.test(path)) {
      return { state: 'auth_required', reason: 'SESSION_NOT_AVAILABLE_IN_RESEARCH_VIEW' };
    }
    let identity;
    if (provider === 'x') {
      const account = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const href = canonical(profile?.href);
      if (account && href) {
        const handle = new URL(href).pathname.slice(1);
        if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) identity = `x:${handle.toLowerCase()}`;
      }
      if (!identity && document.querySelector('a[data-testid="loginButton"],a[href="/i/flow/login"]')) {
        return { state: 'auth_required', reason: 'SESSION_NOT_AVAILABLE_IN_RESEARCH_VIEW' };
      }
    } else {
      const content = 'main,[role="main"],article,[role="dialog"],[role="feed"]';
      const inbox = [...document.querySelectorAll('a[href]')].find((link) => {
        if (link.closest(content)) return false;
        const href = canonical(link.href);
        return href && /^\/direct\/inbox$/.test(new URL(href).pathname);
      });
      const identities = new Set();
      for (const link of [...document.querySelectorAll('a[href]')].slice(0, 500)) {
        if (link.closest(content)) continue;
        const href = canonical(link.href);
        if (!href) continue;
        const profileLabel = /^(Profile|Профиль)$/i.test((link.getAttribute('aria-label') || text(link) || '').trim());
        const profileIcon = link.querySelector('[aria-label="Profile"],[aria-label="Профиль"]');
        const navigation = link.closest('nav,header,[role="navigation"]');
        if (!(profileLabel || profileIcon || navigation && link.querySelector('img'))) continue;
        const handle = new URL(href).pathname.slice(1);
        if (/^[A-Za-z0-9._]{1,30}$/.test(handle)
          && !['explore', 'reels', 'accounts', 'direct'].includes(handle)) {
          identities.add(`instagram:${handle.toLowerCase()}`);
        }
      }
      if (identities.size === 1) identity = [...identities][0];
      if (!identity && document.querySelector('a[href^="/accounts/login"]')) {
        return { state: 'auth_required', reason: 'SESSION_NOT_AVAILABLE_IN_RESEARCH_VIEW' };
      }
      if (!inbox) return { state: 'initializing', reason: 'DOM_ACCOUNT_INBOX_NAV_UNAVAILABLE' };
      if (!identity) return { state: 'initializing', reason: identities.size > 1
        ? 'DOM_ACCOUNT_IDENTITY_AMBIGUOUS' : 'DOM_ACCOUNT_PROFILE_NAV_UNAVAILABLE' };
    }
    return identity ? { state: 'ready', identity }
      : { state: 'initializing', reason: 'DOM_ACCOUNT_PROOF_PENDING' };
  }

  async function waitAuth(job) {
    const end = Math.min(job.expires, now() + DOM_READY_WAIT_MS);
    let proof = authProof();
    while (proof.state === 'initializing' && now() < end) {
      await pause(job, DOM_POLL_INTERVAL_MS);
      proof = authProof();
    }
    if (proof.state === 'initializing') return { state: 'unavailable', reason: proof.reason || 'DOM_ACCOUNT_PROOF_UNAVAILABLE' };
    return proof;
  }

  async function reply(job, event, terminal = false) {
    if (!terminal) guard(job);
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw failure('REPLY_TRANSPORT_UNAVAILABLE');
    const value = { ...event, pageUrl: location.href, documentEpoch: job.documentEpoch, identityProof: job.identity };
    if (encoder.encode(JSON.stringify(value)).byteLength > MAX_FRAME) throw failure('FRAME_TOO_LARGE');
    return invoke('relay_research_social_reply', { requestId: job.requestId, nonce: job.nonce, event: value });
  }

  function assertAccount(job) {
    guard(job);
    const proof = authProof();
    if (proof.state !== 'ready' || proof.identity !== job.identity) throw failure('STALE_ACCOUNT');
  }

  function sourceAccess() {
    const main = document.querySelector('main,[role="main"]');
    if (!main) return { readable: false, code: 'DOM_SOURCE_UNAVAILABLE' };
    const sample = (text(main) || '').slice(0, 16000);
    if (/rate limit exceeded|too many requests|превышен лимит запросов/i.test(sample)) {
      return { readable: false, code: 'RATE_LIMITED' };
    }
    if (/these posts are protected|this account is private|это закрытый аккаунт|эти посты защищены/i.test(sample)) {
      return { readable: false, code: 'ACCESS_DENIED' };
    }
    if (/page isn.t available|this post is unavailable|страница недоступна|публикация недоступна/i.test(sample)) {
      return { readable: false, code: 'SOURCE_UNAVAILABLE' };
    }
    return { readable: true, main, emptyProof: /no posts yet|no results for|no tweets yet|публикаций пока нет|нет публикаций|ничего не найдено/i.test(sample) };
  }

  function observedNumber(raw) {
    if (typeof raw !== 'string') return undefined;
    const clean = raw.trim().replace(/\u00a0|\u202f/g, ' ');
    if (/^\d+$/.test(clean)) return Number(clean);
    if (/^\d{1,3}(?:[ ,]\d{3})+$/.test(clean)) return Number(clean.replace(/[ ,]/g, ''));
    const match = /^(\d+(?:[.,]\d+)?)\s*([KMB]|тыс\.?|млн\.?|млрд\.?)$/i.exec(clean);
    if (!match) return undefined;
    const unit = match[2].toLowerCase();
    const multiplier = /^(k|тыс)/.test(unit) ? 1000 : /^(m|млн)/.test(unit) ? 1000000 : 1000000000;
    return Number(match[1].replace(',', '.')) * multiplier;
  }

  function selectOriginalPhotoSource(image) {
    const hasPhotoUrl = (value) => {
      if (typeof value !== 'string' || value.length > 4096 || !isCdn(value)) return false;
      try { const url = new URL(value); return !url.hash && !url.username && !url.password
        && !/\.(m3u8|mpd)$/i.test(url.pathname); } catch { return false; }
    };
    const current = hasPhotoUrl(image.currentSrc) ? image.currentSrc : image.src;
    const candidates = (image.srcset || '').split(',').map((entry) => {
      const match = /^(https:\/\/\S+)\s+(\d+(?:\.\d+)?)(w|x)$/.exec(entry.trim());
      if (!match || !hasPhotoUrl(match[1])) return undefined;
      const size = Number(match[2]);
      if (!Number.isFinite(size) || size <= 0 || match[3] === 'w' && !Number.isInteger(size)) return undefined;
      return { url: match[1], size, unit: match[3] };
    }).filter(Boolean);
    const selected = candidates.length && candidates.every((candidate) => candidate.unit === candidates[0].unit)
      ? candidates.reduce((best, candidate) => candidate.size > best.size ? candidate : best).url : current;
    if (provider !== 'x' || !hasPhotoUrl(selected)) return selected;
    const original = new URL(selected);
    if (original.hostname === 'pbs.twimg.com' && /^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(original.pathname)
      && original.searchParams.has('name')) original.searchParams.set('name', 'orig');
    return original.href;
  }

  function extractMedia(node, gaps) {
    const result = [];
    const seen = new Set();
    const nodes = node.querySelectorAll('img,video,audio,source,track');
    if (nodes.length > 100) gaps.add('media_nodes_over_100_not_extracted');
    for (const element of [...nodes].slice(0, 100)) {
      const observedUrl = element.currentSrc || element.src;
      const kind = element.tagName.toLowerCase();
      const url = kind === 'img' ? selectOriginalPhotoSource(element) : observedUrl;
      const key = `${kind}:${url || element.poster || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dimensions = {};
      const width = element.naturalWidth || element.videoWidth;
      const height = element.naturalHeight || element.videoHeight;
      if (width > 0) dimensions.width = width;
      if (height > 0) dimensions.height = height;
      const item = {
        kind, sourceUrl: url || undefined, observedSourceUrl: url !== observedUrl ? observedUrl : undefined,
        posterUrl: absolute(element.poster),
        srcset: element.srcset || undefined, description: element.alt || element.title || undefined,
        mimeType: element.type || undefined, dimensions,
        durationSeconds: Number.isFinite(element.duration) ? element.duration : undefined,
        track: kind === 'track' ? { kind: element.kind, language: element.srclang, label: element.label } : undefined,
        access: url?.startsWith('blob:') ? 'blob_unsupported' : /\.m3u8(?:\?|$)|\.mpd(?:\?|$)/i.test(url || '')
          ? 'hls_dash_unsupported' : isCdn(url) ? 'observed_cdn' : 'download_unsupported',
        evidence: { selector: kind, source: location.href, dimensions: 'observed_element' },
      };
      result.push(item);
    }
    return result;
  }

  function extractLinks(node, gaps) {
    const anchors = node.querySelectorAll('a[href]');
    if (anchors.length > 100) gaps.add('links_over_100_not_extracted');
    return [...anchors].slice(0, 100).map((link) => ({ url: absolute(link.href), text: text(link) }))
      .filter((link) => link.url);
  }

  function metrics(node) {
    const result = {};
    for (const name of ['reply', 'retweet', 'like', 'bookmark']) {
      const element = node.querySelector(`[data-testid="${name}"]`);
      if (!element) continue;
      const raw = text(element)?.trim();
      result[name] = { raw, value: observedNumber(raw), label: element.getAttribute('aria-label') || undefined };
    }
    const views = node.querySelector('a[href$="/analytics"]');
    if (views) result.views = { raw: text(views)?.trim(), value: observedNumber(text(views)?.trim()) };
    return result;
  }

  function baseRecord(type, id, source, gaps) {
    return { schemaVersion: 1, provider, type, id, source, observedAt: new Date(now()).toISOString(),
      access: 'accessible_dom', extraction: 'first_party_dom', unresolvedFields: [...gaps] };
  }

  function tweetRecord(node, job) {
    const time = node.querySelector('time');
    const link = time?.closest('a') || node.querySelector('a[href*="/status/"]');
    const source = canonical(link?.href);
    const match = source && /\/(?:[A-Za-z0-9_]+\/status|i\/status)\/(\d+)/.exec(new URL(source).pathname);
    if (!match) return undefined;
    if (['read', 'download'].includes(job.operation) && !job.input.includeReplies && /\/status\/\d+/.test(job.targetPath)
      && !job.targetPath.endsWith(`/status/${match[1]}`)) return undefined;
    const gaps = new Set(['api_only_fields_not_observed']);
    const body = text(node.querySelector('[data-testid="tweetText"]'));
    const author = text(node.querySelector('[data-testid="User-Name"]'));
    const media = extractMedia(node, gaps);
    const record = baseRecord('post', `x:${match[1]}`, source, gaps);
    return { ...record, text: body, author: { observedText: author }, timestamp: time?.dateTime || undefined,
      metrics: metrics(node), media, links: extractLinks(node, gaps),
      descriptions: [...node.querySelectorAll('img[alt]')].slice(0, 100).map((image) => image.alt),
      unresolvedFields: [...gaps],
      fieldEvidence: { text: '[data-testid=tweetText]', author: '[data-testid=User-Name]', timestamp: 'time[datetime]' } };
  }

  function instagramRecord(node, job) {
    const link = node.matches('a[href]') ? node : node.querySelector('a[href*="/p/"],a[href*="/reel/"]');
    let source = link ? canonical(link.href) : undefined;
    if (!link && instagramPostLocator(location.href)) source = canonical(location.href);
    const locator = instagramPostLocator(source);
    if (!locator) return undefined;
    if (['read', 'download'].includes(job.operation) && !sameInstagramPost(source, job.target)) return undefined;
    const gaps = new Set(['api_only_fields_not_observed']);
    const media = extractMedia(node, gaps);
    const pageDescription = meta('og:description');
    const nodeCaption = text(node.querySelector('h1'));
    const caption = nodeCaption || (sameInstagramPost(location.href, source) ? pageDescription : undefined);
    if (!caption) gaps.add('caption_not_observed');
    const timestamp = node.querySelector('time')?.dateTime;
    if (!timestamp) gaps.add('timestamp_not_observed');
    const observedAuthor = text(node.querySelector('header'));
    gaps.add('publisher_identity_unverified');
    gaps.add('collaboration_unverified');
    return { ...baseRecord(locator.kind === 'p' ? 'post' : 'reel', `instagram:${locator.shortcode}`, source, gaps),
      text: caption, description: pageDescription, timestamp, media,
      author: { observedText: observedAuthor }, links: extractLinks(node, gaps),
      sourceContext: { pageUrl: location.href, requestedSource: job.target, collection: 'visible_dom' },
      // Preserve the legacy flat field without duplicating its potentially large bytes.
      pageMetadata: { sourceUrl: location.href, descriptionField: pageDescription ? 'description' : undefined },
      metrics: {}, observedText: text(node), unresolvedFields: [...gaps],
      fieldEvidence: {
        ...(caption ? { text: nodeCaption ? 'h1 within observed post node'
          : 'meta[og:description] on the validated same-post page' } : {}),
        ...(pageDescription ? { description: 'document meta[og:description]; pageMetadata.sourceUrl' } : {}),
        ...(observedAuthor ? { author: 'header text within observed record node; identity unverified' } : {}),
        ...(timestamp ? { timestamp: 'time[datetime] within observed record node' } : {}),
        media: 'img/video/source/track',
      } };
  }

  function profileRecord(job) {
    const main = document.querySelector('main,[role="main"]');
    const header = provider === 'x' ? main?.querySelector('[data-testid="UserName"]') : main?.querySelector('header');
    const title = text(header) || meta('og:title');
    if (!title) return undefined;
    const gaps = new Set(['api_only_profile_fields_not_observed']);
    const description = provider === 'x' ? text(main?.querySelector('[data-testid="UserDescription"]')) : meta('og:description');
    const observedMetrics = {};
    for (const link of main?.querySelectorAll('a[href*="/followers"],a[href*="/following"]') || []) {
      const kind = link.href.includes('/followers') ? 'followers' : 'following';
      observedMetrics[kind] = { raw: text(link), title: link.title || undefined,
        value: observedNumber(text(link.querySelector('span'))?.trim()) };
    }
    return { ...baseRecord('profile', `${provider}:profile:${job.targetPath}`, canonical(location.href), gaps),
      title, text: description, description, handle: job.targetPath.replace(/^\//, ''),
      metrics: observedMetrics, media: extractMedia(header || main, gaps), links: extractLinks(header || main, gaps),
      unresolvedFields: [...gaps], fieldEvidence: { title: 'profile header or og:title', description: 'profile description or og:description' } };
  }

  async function threadRecords(job) {
    const scope = provider === 'x' ? document.querySelector('[data-testid="DMConversationContainer"]')
      : document.querySelector('[data-testid="conversation-thread"],[data-pagelet="IGDThreadMessages"],[data-scope="messages_table"]');
    if (!scope) throw failure('THREAD_DOM_UNSUPPORTED');
    const nodes = scope.querySelectorAll('[data-testid="messageEntry"],[data-message-id],[data-testid="message"]');
    if (!nodes.length) throw failure('THREAD_DOM_UNSUPPORTED');
    const result = [];
    for (const node of [...nodes].reverse().slice(0, 100)) {
      const gaps = new Set(['server_message_id_may_be_unavailable', 'thread_history_is_dom_partial']);
      const body = text(node);
      const timestamp = node.querySelector('time')?.dateTime;
      const media = extractMedia(node, gaps);
      const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([body, timestamp, media])));
      const digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const observedId = node.getAttribute('data-message-id');
      result.push({ ...baseRecord('message', `${job.sourceKey}:${observedId || digest.slice(0, 32)}`, canonical(location.href), gaps),
        text: body, timestamp, author: { observedText: node.getAttribute('data-sender-name') || undefined },
        media, links: extractLinks(node, gaps), unresolvedFields: [...gaps] });
    }
    return result;
  }

  async function collect(job) {
    if (job.operation === 'read_thread') return threadRecords(job);
    if (job.operation === 'profile' || provider === 'instagram' && job.scope === 'profiles') {
      return [profileRecord(job)].filter(Boolean);
    }
    if (job.operation === 'article') {
      const article = document.querySelector('[data-testid="twitterArticleReadView"],[data-testid="articleReadView"],main article');
      if (!article) throw failure('ARTICLE_DOM_UNSUPPORTED');
      const gaps = new Set(['article_dom_only', 'api_only_fields_not_observed']);
      return [{ ...baseRecord('article', `x:article:${job.targetPath}`, canonical(location.href), gaps),
        text: text(article), title: text(article.querySelector('h1')), author: { observedText: text(article.querySelector('[data-testid="User-Name"]')) },
        timestamp: article.querySelector('time')?.dateTime, media: extractMedia(article, gaps), links: extractLinks(article, gaps),
        unresolvedFields: [...gaps] }];
    }
    if (provider === 'x' && job.scope === 'profiles') {
      const records = [];
      for (const node of [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, 100)) {
        const link = node.querySelector('a[href]');
        const source = canonical(link?.href);
        if (!source) continue;
        const gaps = new Set(['search_result_profile_preview']);
        records.push({ ...baseRecord('profile', `x:profile:${new URL(source).pathname}`, source, gaps),
          text: text(node), media: extractMedia(node, gaps), links: extractLinks(node, gaps), unresolvedFields: [...gaps] });
      }
      return records;
    }
    if (provider === 'x') return [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 100)
      .map((node) => tweetRecord(node, job)).filter(Boolean);
    const articles = [...document.querySelectorAll('main article,[role="main"] article')];
    if (articles.length) return articles.slice(0, 100).map((node) => instagramRecord(node, job)).filter(Boolean);
    return [...document.querySelectorAll('main a[href*="/p/"],main a[href*="/reel/"],[role="main"] a[href*="/p/"]')]
      .slice(0, 100).map((node) => instagramRecord(node, job)).filter(Boolean);
  }

  function base64(bytes) {
    let result = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(result);
  }

  async function download(job, descriptor) {
    const sourceUrl = descriptor.sourceUrl;
    if (!isCdn(sourceUrl) || descriptor.access !== 'observed_cdn') {
      job.gaps.add(`media_${descriptor.access || 'unsupported'}`);
      return;
    }
    if (job.downloaded.has(sourceUrl)) return;
    job.downloaded.add(sourceUrl);
    if (job.downloaded.size > (job.mediaFilesRemaining ?? MAX_MEDIA_FILES)) { job.gaps.add('media_file_limit_500'); return; }
    assertAccount(job);
    const options = { signal: job.controller.signal, credentials: 'same-origin', mode: 'cors', redirect: 'error', cache: 'no-store' };
    let response;
    try { response = await fetch(sourceUrl, options); }
    catch { job.gaps.add('media_fetch_cors_or_network_unavailable'); return; }
    const lengthRaw = response.headers.get('content-length');
    const declaredBytes = /^\d+$/.test(lengthRaw || '') ? Number(lengthRaw) : undefined;
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' };
    let rejected;
    if (!response.ok || !response.body || response.url !== sourceUrl) rejected = 'media_response_changed';
    else if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) rejected = 'media_size_unknown_or_get_denied';
    else if (!extensions[mimeType]) rejected = 'media_mime_unsupported';
    else if (declaredBytes > MAX_FILE || job.mediaBytes + declaredBytes > MAX_JOB_MEDIA) rejected = 'media_byte_budget';
    if (rejected) {
      await response.body?.cancel().catch(() => {}); job.gaps.add(rejected); return;
    }
    const mediaId = `${job.jobId}-${job.targetIndex}-${job.pageIndex || 0}-${++job.mediaSequence}`;
    const reader = response.body.getReader();
    let total = 0;
    let sequence = 0;
    try {
      await reply(job, { kind: 'media_open', mediaId, fileName: `media-${job.targetIndex}-${job.pageIndex || 0}-${job.mediaSequence}.${extensions[mimeType]}`,
        mimeType, declaredBytes, sourceUrl });
      while (true) {
        assertAccount(job);
        const next = await reader.read();
        if (next.done) break;
        for (let offset = 0; offset < next.value.byteLength; offset += MAX_CHUNK) {
          const chunk = next.value.subarray(offset, Math.min(offset + MAX_CHUNK, next.value.byteLength));
          if (total + chunk.byteLength > declaredBytes || job.mediaBytes + chunk.byteLength > MAX_JOB_MEDIA) throw failure('MEDIA_SIZE_CHANGED');
          total += chunk.byteLength;
          job.mediaBytes += chunk.byteLength;
          await reply(job, { kind: 'media_chunk', mediaId, sequence: sequence++, base64: base64(chunk) });
        }
      }
      if (total !== declaredBytes) throw failure('MEDIA_SIZE_CHANGED');
      await reply(job, { kind: 'media_close', mediaId, totalBytes: total });
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async function emitRecord(job, record) {
    assertAccount(job);
    if (job.seen.has(record.id)) return false;
    const timestamp = record.timestamp && Date.parse(record.timestamp) / 1000;
    if (job.input.after !== undefined || job.input.before !== undefined) {
      if (!Number.isFinite(timestamp)) throw failure('TIMESTAMP_FILTER_UNSUPPORTED');
      if (job.input.after !== undefined && timestamp < job.input.after
        || job.input.before !== undefined && timestamp > job.input.before) return false;
    }
    job.seen.add(record.id);
    let fullText = record.text;
    const fields = {};
    const ranges = new Map();
    if (typeof fullText === 'string') {
      fields.text = { offset: 0, length: fullText.length };
      ranges.set(fullText, fields.text);
    }
    let packedFields = false;
    for (const field of ['caption', 'description', 'observedText', 'title']) {
      const value = record[field];
      if (typeof value !== 'string' || value.length < 8000) continue;
      packedFields = true;
      delete record[field];
      let range = ranges.get(value);
      if (!range) {
        const prefix = typeof fullText === 'string' && fullText.length ? `${fullText}\n` : '';
        range = { offset: prefix.length, length: value.length };
        fullText = `${prefix}${value}`;
        ranges.set(value, range);
      }
      fields[field] = range;
    }
    if (packedFields) record.textFields = fields;
    if (typeof fullText === 'string' && !packedFields) record.text = fullText;
    if (typeof fullText === 'string' && encoder.encode(fullText).byteLength > 4194304) throw failure('TEXT_LIMIT');
    if (typeof fullText === 'string' && (fullText.length > 12000 || packedFields)) {
      delete record.text;
      for (let offset = 0, index = 0; offset < fullText.length; index += 1) {
        let end = Math.min(offset + 12000, fullText.length);
        const tail = fullText.charCodeAt(end - 1);
        if (end < fullText.length && tail >= 0xD800 && tail <= 0xDBFF) end -= 1;
        const item = index === 0 ? record : { schemaVersion: 1, type: record.type, id: record.id, source: record.source };
        await reply(job, { kind: 'records', records: [{ ...item,
          textPart: { index, text: fullText.slice(offset, end), final: end >= fullText.length } }],
        coverage: { source: job.target, extraction: 'visible_dom', accessible: true, completeness: 'partial' } });
        offset = end;
      }
    } else {
      await reply(job, { kind: 'records', records: [record],
        coverage: { source: job.target, extraction: 'visible_dom', accessible: true, completeness: 'partial' } });
    }
    job.count += 1;
    job.lastAnchor = record.type === 'message' ? record.id : record.source || record.id;
    if (job.operation === 'download' || job.input.includeMedia) {
      for (const descriptor of record.media || []) await download(job, descriptor);
    }
    return true;
  }

  async function waitSource(job) {
    const end = Math.min(job.expires, now() + DOM_READY_WAIT_MS);
    let access;
    let retryCode;
    while (true) {
      assertAccount(job);
      access = sourceAccess();
      if (!access.readable && access.code !== 'DOM_SOURCE_UNAVAILABLE') throw failure(access.code);
      if (access.readable) {
        try {
          const records = await collect(job);
          if (records.length || access.emptyProof) return { access, records };
          retryCode = 'DOM_SOURCE_UNSUPPORTED';
        } catch (error) {
          if (!['THREAD_DOM_UNSUPPORTED', 'ARTICLE_DOM_UNSUPPORTED'].includes(error.code)) throw error;
          retryCode = error.code;
        }
      } else { retryCode = access.code; }
      if (now() >= end) throw failure(retryCode);
      await pause(job, DOM_POLL_INTERVAL_MS);
    }
  }

  async function extract(job) {
    const initial = await waitSource(job);
    const access = initial.access;
    let anchorReached = !job.cursor?.anchor;
    let stagnant = 0;
    let observedNodes = 0;
    let exhausted = false;
    for (let turn = 0; turn < 200 && job.count < job.limit; turn += 1) {
      assertAccount(job);
      const records = turn === 0 ? initial.records : await collect(job);
      observedNodes += records.length;
      const before = job.count;
      const beforeSeen = job.seen.size;
      for (const record of records) {
        if (!anchorReached) {
          job.seen.add(record.id);
          if (record.source === job.cursor.anchor || record.id === job.cursor.anchor) anchorReached = true;
          continue;
        }
        await emitRecord(job, record);
        if (job.count >= job.limit) break;
      }
      const fixed = ['article', 'profile'].includes(job.operation)
        || ['read', 'download'].includes(job.operation) && !job.input.includeReplies;
      if (fixed || access.emptyProof) { exhausted = true; break; }
      if (job.count >= job.limit) break;
      stagnant = before === job.count && beforeSeen === job.seen.size ? stagnant + 1 : 0;
      if (stagnant >= 4) break;
      const scroller = job.operation === 'read_thread'
        ? document.querySelector('[data-testid="DMConversationContainer"],[data-testid="conversation-thread"],[data-pagelet="IGDThreadMessages"],[data-scope="messages_table"]')
        : document.scrollingElement;
      if (!scroller) break;
      scroller.scrollBy({ top: job.operation === 'read_thread' ? -Math.max(600, scroller.clientHeight) : Math.max(600, scroller.clientHeight), behavior: 'instant' });
      await pause(job, 700);
      const nextAccess = sourceAccess();
      if (!nextAccess.readable) throw failure(nextAccess.code);
    }
    if (!anchorReached) throw failure('CURSOR_ANCHOR_NOT_FOUND');
    if (!job.count && !access.emptyProof && observedNodes === 0) throw failure('DOM_SOURCE_UNSUPPORTED');
    const noProgress = Boolean(job.cursor?.anchor && anchorReached && observedNodes > 0
      && !job.count && !access.emptyProof && !exhausted);
    if (noProgress) job.gaps.add('cursor_no_progress');
    if (!exhausted) job.gaps.add('virtualized_dom_history_incomplete');
    const coverage = { source: job.target, accessible: true, extraction: 'visible_dom',
      completeness: exhausted && !job.gaps.size ? 'complete' : 'partial', unresolved: [...job.gaps],
      recordsObserved: job.count, includeRepliesRequested: Boolean(job.input.includeReplies),
      universal_api_or_private_thread_discovery: false };
    const cursor = job.lastAnchor && !exhausted ? { schemaVersion: 1, provider, operation: job.operation,
      sourceKey: job.sourceKey, accountEpoch: job.accountEpoch, targetIndex: job.targetIndex, anchor: job.lastAnchor,
      offset: (job.cursor?.offset || 0) + job.count } : noProgress ? job.cursor : undefined;
    await reply(job, { kind: 'page_done', count: job.count, partial: coverage.completeness === 'partial',
      coverage, nextCursor: cursor ? JSON.stringify(cursor) : undefined, accessible: true, emptyProof: access.emptyProof,
      resumeProof: noProgress ? { anchor: job.cursor.anchor, anchorReached: true, recordsObserved: observedNodes } : undefined });
  }

  async function start(request) {
    if (active) return;
    if (!request || typeof request.requestId !== 'string' || typeof request.nonce !== 'string'
      || request.provider !== provider || !Number.isInteger(request.deadlineMs) || request.deadlineMs < 1
      || request.deadlineMs > 300000) return;
    const job = { ...request, input: request.input || {}, controller: new AbortController(),
      expires: now() + request.deadlineMs, count: 0, mediaBytes: 0, mediaSequence: 0,
      seen: new Set(), downloaded: new Set(), gaps: new Set(),
      limit: Math.min(request.limit || 100, request.input?.pageSize || 50, 100) };
    active = job;
    const deadline = setTimeout(() => { job.abortCode = 'DEADLINE'; job.controller.abort(); }, request.deadlineMs);
    try {
      const proof = await waitAuth(job);
      await reply(job, { kind: 'auth', ...proof });
      if (proof.state !== 'ready' || request.phase === 'probe') return;
      job.identity = proof.identity;
      job.targetPath = new URL(request.target).pathname.replace(/\/+$/, '');
      const current = canonical(location.href);
      const target = canonical(request.target);
      if (!current || !target) throw failure('SOURCE_CHANGED');
      const samePost = provider === 'x' && /\/status\/\d+$/.test(new URL(current).pathname)
        && /\/status\/\d+$/.test(new URL(target).pathname)
        && new URL(current).pathname.split('/').pop() === new URL(target).pathname.split('/').pop();
      const sameReel = provider === 'instagram' && sameInstagramPost(current, target);
      if (current !== target && !samePost && !sameReel) throw failure('SOURCE_CHANGED');
      if (job.input.cursor) job.cursor = JSON.parse(job.input.cursor);
      await extract(job);
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code
        : job.controller.signal.aborted ? job.abortCode || (now() >= job.expires ? 'DEADLINE' : 'CANCELLED') : 'EXTRACTION_FAILED';
      await reply(job, { kind: 'error', code, reason: code }, true).catch(() => {});
    } finally { clearTimeout(deadline); if (active === job) active = undefined; }
  }

  function cancel(requestId, nonce) {
    if (active?.requestId === requestId && active.nonce === nonce) active.controller.abort();
  }

  window.addEventListener('storage', (event) => {
    if (active && (typeof event.key !== 'string' || /auth|login|logout|session|account|current.?user|user.?id/i.test(event.key))) {
      active.abortCode = 'STALE_ACCOUNT';
      active.controller.abort();
    }
  });

  Object.defineProperty(window, '__egoistSocialResearch', { value: Object.freeze({ start, cancel }), configurable: false });
}());
