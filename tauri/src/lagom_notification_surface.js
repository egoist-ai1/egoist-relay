(() => {
  if (window.berestaToast) return;

  const brands = {
    // Те же знаки, что на панели сервисов Бересты.
    telegram: {
      name: 'Telegram',
      notes: [466.16, 622.25],
      mark: '<svg viewBox="18 32 76 64" aria-hidden="true"><path fill="currentColor" d="M23.775 58.77a3278.85 3278.85 0 0 1 39.27-16.223c18.698-7.454 21.3-8.542 23.828-8.58a4.995 4.995 0 0 1 2.977 1.103c1.058.9 1.38 1.47 1.47 1.972.083.503.075 2.07-.015 2.963-1.013 10.207-4.86 33.78-7.088 45.225-.945 4.837-2.805 6.457-4.605 6.615-3.907.345-6.877-2.475-10.664-4.86-5.925-3.728-7.905-5.1-13.65-8.737-6.653-4.2-3.916-5.663-.128-9.436.99-.982 17.415-15.974 17.662-17.34.21-1.2.286-1.357-.254-1.897-.548-.54-1.2-.473-1.62-.383-.6.128-9.645 5.85-27.15 17.176-2.685 1.777-5.115 2.64-7.298 2.595-2.4-.053-7.027-1.305-10.462-2.378-4.223-1.32-7.575-2.01-7.275-4.245.15-1.163 1.814-2.355 5.002-3.57Z"/></svg>',
    },
    x: {
      name: 'X',
      notes: [440, 554.37],
      mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    },
    instagram: {
      name: 'Instagram',
      notes: [493.88, 659.25],
      mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01" stroke-width="2.5"/></svg>',
    },
  };
  const minPortraitSide = 40;
  let nodes;
  let currentId;
  let preparedHeight = 0;
  let sound;
  let isRevealed = false;
  let queued;
  let audio;
  let frame = 0;

  function make(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.append(node);
    return node;
  }

  function send(action) {
    if (isRevealed && currentId && !nodes.card.classList.contains('fading')) {
      window.location.href = `https://beresta.invalid/notice/${action}/${currentId}`;
    }
  }

  function play(volume, id, notes) {
    if (!Number.isFinite(volume) || volume <= 0 || !window.AudioContext) return;
    try {
      audio ??= new AudioContext();
      void audio.resume().then(() => {
        if (currentId !== id || nodes.card.classList.contains('fading')) return;
        const start = audio.currentTime + 0.02;
        const amplitude = Math.min(volume, 1) * 0.13;
        notes.forEach((frequency, index) => {
          const onset = start + index * 0.085;
          const peak = amplitude * (index ? 0.70 : 1);
          const tone = audio.createOscillator();
          const level = audio.createGain();
          tone.type = 'sine';
          tone.frequency.value = frequency;
          level.gain.setValueAtTime(0, onset);
          level.gain.linearRampToValueAtTime(peak, onset + 0.025);
          level.gain.exponentialRampToValueAtTime(peak * 0.015, onset + 0.18);
          level.gain.linearRampToValueAtTime(0, onset + 0.20);
          tone.connect(level).connect(audio.destination);
          tone.start(onset);
          tone.stop(onset + 0.20);
        });
      }).catch(() => {});
    } catch {
      // Сбой звука не мешает показу карточки.
    }
  }

  function clear() {
    queued = undefined;
    currentId = undefined;
    preparedHeight = 0;
    sound = undefined;
    isRevealed = false;
    cancelAnimationFrame(frame);
    if (!nodes) return;
    nodes.card.hidden = true;
    nodes.card.classList.remove('shown', 'entering', 'fading');
    nodes.link.removeAttribute('aria-label');
    nodes.title.textContent = '';
    nodes.body.textContent = '';
    nodes.name.textContent = '';
    nodes.mark.replaceChildren();
    nodes.serviceMark.replaceChildren();
    applyIcon(undefined);
  }

  function isIcon(source) {
    return /^data:image\/(png|jpe?g|gif|webp);base64,/.test(source ?? '');
  }

  function applyIcon(source) {
    if (source === nodes.icon.getAttribute('src')) return;
    nodes.avatar.removeAttribute('data-photo');
    nodes.icon.hidden = true;
    if (isIcon(source)) nodes.icon.src = source;
    else nodes.icon.removeAttribute('src');
  }

  function setIcon(id, source) {
    if (!isIcon(source)) return;
    if (queued?.notice.id === id) {
      queued.notice = { ...queued.notice, icon: source };
    } else if (nodes && currentId === id) {
      applyIcon(source);
    }
  }

  function prepare(notice) {
    if (
      !notice
      || !Object.hasOwn(brands, notice.service)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(notice.id)
    ) return 0;
    if (!nodes && document.body) init();
    if (!nodes) {
      queued = { notice, reveal: false };
      return 0;
    }
    if (currentId === notice.id) return preparedHeight;
    cancelAnimationFrame(frame);
    currentId = notice.id;
    isRevealed = false;
    const brand = brands[notice.service];
    sound = { volume: notice.volume, notes: brand.notes };
    const title = notice.title === brand.name ? '' : notice.title;
    document.documentElement.dataset.theme = notice.isDark ? 'dark' : 'light';
    document.documentElement.dir = 'ltr';
    nodes.name.textContent = brand.name;
    nodes.title.textContent = title;
    nodes.title.hidden = !title;
    nodes.body.textContent = notice.body;
    nodes.body.hidden = !notice.body;
    nodes.mark.innerHTML = brand.mark;
    nodes.serviceMark.innerHTML = brand.mark;
    applyIcon(notice.icon);
    nodes.link.setAttribute('aria-label', [brand.name, title, notice.body].filter(Boolean).join('. '));
    nodes.card.classList.remove('shown', 'entering', 'fading');
    nodes.card.hidden = false;
    nodes.copy.scrollTop = 0;
    const bounds = nodes.card.getBoundingClientRect();
    preparedHeight = bounds.height + bounds.top * 2;
    return preparedHeight;
  }

  function reveal(id) {
    if (currentId !== id || !nodes || isRevealed) return;
    isRevealed = true;
    nodes.card.classList.add('shown');
    frame = requestAnimationFrame(() => {
      if (currentId !== id || nodes.card.classList.contains('fading')) return;
      nodes.card.classList.add('entering');
      play(sound.volume, id, sound.notes);
    });
  }

  function fade(id) {
    if (currentId !== id || !nodes || !isRevealed) return;
    cancelAnimationFrame(frame);
    nodes.card.classList.remove('entering');
    nodes.card.classList.add('fading');
  }

  function show(notice) {
    if (prepare(notice) > 0) reveal(notice.id);
    else if (queued?.notice === notice) queued.reveal = true;
  }

  function init() {
    if (nodes) return;
    document.documentElement.lang = 'ru';
    const policy = make('meta', null, document.head);
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
    const viewport = make('meta', null, document.head);
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    const style = make('style', null, document.head);
    style.textContent = `
      :root {
        color-scheme: dark;
        --surface-1: #141416;
        --surface-2: #1C1C1E;
        --line: #3A3A3D;
        --text: #EDEBE6;
        --text-soft: #D6D5D0;
        --text-muted: #8C8A85;
        --shadow: #00000080;
        --radius-sm: 6px;
        --radius-md: 12px;
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 12px;
        --space-6: 32px;
        --avatar-size: 48px;
        --column-gap: 12px;
        --notice-min-height: 88px;
        --notice-max-height: 260px;
        --dur-fast: 160ms;
        --dur-fade: 220ms;
        --ease-standard: cubic-bezier(.2,.7,.2,1);
      }
      :root[data-theme="light"] {
        color-scheme: light;
        --surface-1: #FFFFFF;
        --surface-2: #EDEBE6;
        --line: #D6D5D0;
        --text: #0A0A0B;
        --text-soft: #26262A;
        --text-muted: #646460;
        --shadow: #0A0A0B33;
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      body {
        overflow: hidden;
        margin: 0;
        width: 100vw;
        height: 100vh;
        padding: var(--space-1);
        color: var(--text);
        background: transparent;
        font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
        font-size: 14px;
      }
      .card {
        position: relative;
        overflow: hidden;
        display: flex;
        min-height: var(--notice-min-height);
        max-height: var(--notice-max-height);
        width: 100%;
        border: 1px solid var(--line);
        border-radius: var(--radius-md);
        background: var(--surface-1);
        box-shadow: 0 2px 6px var(--shadow);
        visibility: hidden;
      }
      .shown {
        visibility: visible;
        transition: opacity var(--dur-fade) var(--ease-standard), transform var(--dur-fade) var(--ease-standard);
      }
      .entering { animation: enter var(--dur-fast) var(--ease-standard); }
      @keyframes enter { from { transform: translateY(var(--space-1)); opacity: .72; } }
      .fading {
        opacity: 0;
        transform: translateY(var(--space-1));
        pointer-events: none;
      }
      @media (prefers-reduced-motion: reduce) {
        .entering { animation: none; }
        .shown { transition: none; }
        .fading { transform: none; }
      }
      button { cursor: pointer; color: inherit; font: inherit; }
      button:focus-visible { outline: 2px solid var(--text); outline-offset: -4px; }
      .open {
        display: grid;
        grid-template-columns: var(--avatar-size) minmax(0, 1fr) var(--avatar-size);
        gap: var(--column-gap);
        align-items: center;
        width: 100%;
        padding: var(--space-2) var(--space-3);
        border: 0;
        border-radius: var(--radius-md);
        background: transparent;
        text-align: center;
      }
      .avatar {
        position: relative;
        display: grid;
        place-items: center;
        width: var(--avatar-size);
        height: var(--avatar-size);
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 50%;
        color: var(--text);
        background: var(--surface-2);
      }
      .avatar img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border-radius: inherit;
        object-fit: cover;
      }
      .mark {
        display: grid;
        place-items: center;
        position: absolute;
        inset: 0;
        z-index: 1;
      }
      .mark svg { width: 24px; height: 24px; }
      .avatar[data-photo] .mark { display: none; }
      .copy {
        display: grid;
        gap: var(--space-1);
        min-width: 0;
        max-height: calc(var(--notice-max-height) - 2 * var(--space-2) - 2px);
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-gutter: stable both-edges;
      }
      .service {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: var(--space-1);
        color: var(--text-muted);
        font-size: 12px;
        font-weight: 500;
        line-height: 16px;
      }
      .service-mark { display: none; color: var(--text-soft); }
      .service-mark svg { display: block; width: 14px; height: 14px; }
      .avatar[data-photo] + .copy .service-mark { display: inline-flex; }
      .title { font-size: 16px; font-weight: 600; line-height: 22px; }
      .body { color: var(--text-soft); font-size: 14px; line-height: 20px; white-space: pre-wrap; }
      .body, .title {
        overflow-wrap: anywhere;
      }
      .dismiss {
        position: absolute;
        inset: 50% calc(var(--space-3) + (var(--avatar-size) - var(--space-6)) / 2) auto auto;
        transform: translateY(-50%);
        display: grid;
        place-items: center;
        width: var(--space-6);
        height: var(--space-6);
        padding: 0;
        border: 0;
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        background: transparent;
      }
      .dismiss svg { width: 16px; height: 16px; }
      .dismiss:hover { color: var(--text); background: var(--surface-2); }
      @media (max-width: 280px) {
        :root { --avatar-size: 36px; --column-gap: 8px; }
        .mark svg { width: 20px; height: 20px; }
      }
      @media (forced-colors: active) {
        :root, :root[data-theme="light"] {
          --surface-1: Canvas;
          --surface-2: Canvas;
          --line: CanvasText;
          --text: CanvasText;
          --text-soft: CanvasText;
          --text-muted: CanvasText;
        }
        button:focus-visible { outline-color: Highlight; }
      }
    `;
    const card = make('section', 'card', document.body);
    card.hidden = true;
    const link = make('button', 'open', card);
    link.type = 'button';
    link.addEventListener('click', () => send('open'));
    const avatar = make('span', 'avatar', link);
    avatar.setAttribute('aria-hidden', 'true');
    const mark = make('span', 'mark', avatar);
    const icon = make('img', null, avatar);
    icon.alt = '';
    icon.decoding = 'async';
    icon.draggable = false;
    icon.hidden = true;
    icon.addEventListener('load', () => {
      if (icon.currentSrc !== icon.getAttribute('src')) return;
      if (Math.min(icon.naturalWidth, icon.naturalHeight) < minPortraitSide) return;
      icon.hidden = false;
      avatar.setAttribute('data-photo', '');
    });
    icon.addEventListener('error', () => {
      icon.hidden = true;
      avatar.removeAttribute('data-photo');
    });
    const copy = make('span', 'copy', link);
    const service = make('span', 'service', copy);
    const serviceMark = make('span', 'service-mark', service);
    serviceMark.setAttribute('aria-hidden', 'true');
    const name = make('span', null, service);
    const title = make('span', 'title', copy);
    const body = make('span', 'body', copy);
    link.addEventListener('keydown', (event) => {
      if (copy.scrollHeight <= copy.clientHeight) return;
      const distance = {
        ArrowDown: 24,
        ArrowUp: -24,
        PageDown: copy.clientHeight,
        PageUp: -copy.clientHeight,
      }[event.key];
      if (!distance) return;
      event.preventDefault();
      copy.scrollBy({ top: distance });
    });
    title.dir = 'auto';
    body.dir = 'auto';
    const dismiss = make('button', 'dismiss', card);
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Закрыть уведомление');
    dismiss.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    dismiss.addEventListener('click', () => send('close'));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !currentId) return;
      event.preventDefault();
      send('close');
    });
    nodes = { card, link, avatar, mark, icon, copy, name, serviceMark, title, body };
    if (queued) {
      const pending = queued;
      queued = undefined;
      prepare(pending.notice);
      if (pending.reveal) reveal(pending.notice.id);
    }
  }

  window.berestaToast = Object.freeze({ prepare, reveal, fade, show, setIcon, clear });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
