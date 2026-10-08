import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startAuditServer(output, port = 1251, { baselineDirectory } = {}) {
  await mkdir(output, { recursive: true });
  const packageJson = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const tg = { TG_APP_ENV: 'development', TG_APP_MOCKED_CLIENT: '1', TG_APP_TITLE: 'Egoist Relay UI audit',
    TG_PUBLIC_URL: `http://127.0.0.1:${port}`, TG_TELEGRAM_API_ID: '0', TG_TELEGRAM_API_HASH: '', TG_TEST_SESSION: '' };
  const define = { APP_VERSION: JSON.stringify(packageJson.version), 'import.meta.env.DEV': 'false' };
  for (const [key, value] of Object.entries(tg)) define[`import.meta.env.${key}`] = JSON.stringify(value);
  const mockModules = new Map([
    ['@tauri-apps/api/core', `export const isTauri=()=>typeof window!=='undefined' && Boolean(window.isTauri);
      export const invoke=(command,args)=>window.__relayNativeMock.invoke(command,args);
      export const convertFileSrc=(path)=>path;`],
    ['@tauri-apps/api/event', `export const listen=async(name,callback)=>window.__relayNativeMock.listen(name,callback);
      export const emit=async(name,payload)=>window.__relayNativeMock.emit(name,payload);`],
    ['@tauri-apps/api/window', `export const getCurrentWindow=()=>window.__relayNativeMock.currentWindow;
      export const getAllWindows=async()=>[window.__relayNativeMock.currentWindow];`],
    ['@tauri-apps/plugin-shell', `export const open=async(url)=>{window.__relayNativeMock.external.push(url);};`],
    ['@tauri-apps/plugin-notification', `export const isPermissionGranted=async()=>false;
      export const requestPermission=async()=> 'denied'; export const sendNotification=()=>{};`],
    ['virtual:git-info', `export const APP_REVISION='ui-audit-mocked';`],
  ]);
  const server = await createServer({ root: project, configFile: false, assetsInclude: ['**/*.tgs'],
    cacheDir: path.join(output, 'vite-cache'), define, logLevel: 'error',
    optimizeDeps: { entries: ['scripts/relay-ui-audit.fixture.tsx'], exclude: ['temml'] },
    resolve: { tsconfigPaths: true, alias: [{ find: /^@teact$/, replacement: path.join(project, 'src/lib/teact/teact.ts') }, { find: /^@teact\//, replacement: path.join(project, 'src/lib/teact') + '/' }, { find: /^(?:\.\/client|(?:\.\.\/)*lib\/gramjs\/client)\/TelegramClient$/,
      replacement: path.join(project, 'src/lib/gramjs/client/MockClient.ts') }] },
    oxc: { jsx: { runtime: 'automatic', importSource: '@teact' } },
    css: { modules: { localsConvention: 'camelCase', generateScopedName: '[name]__[local]' } },
    server: { host: '127.0.0.1', port, strictPort: true, watch: null, headers: { 'Service-Worker-Allowed': '/' } },
    plugins: [{ name: 'relay-ui-audit-isolated-transport', enforce: 'pre',
      resolveId(id) { return mockModules.has(id) ? `\0relay-audit:${id}` : undefined; },
      async load(id) {
        if (id.startsWith('\0relay-audit:')) return mockModules.get(id.slice('\0relay-audit:'.length));
        if (!baselineDirectory || id.startsWith('\0')) return undefined;
        // Let Vite generate worker/asset wrappers; their actual source is loaded separately.
        if (/[?&](?:worker|url|raw)(?:[=&]|$)/.test(id)) return undefined;
        const sourcePath = id.split('?')[0];
        if (!path.isAbsolute(sourcePath)) return undefined;
        const relative = path.relative(project, sourcePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)
          || relative.split(path.sep)[0] === 'scripts' || relative.split(path.sep)[0] === 'node_modules'
          || !/\.(?:ts|tsx|scss|css|json)$/.test(relative)) return undefined;
        try { return await readFile(path.join(baselineDirectory, relative), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      },
      configureServer(instance) {
        // Эмодзи: в сборке их копирует vite-plugin-static-copy, в харнессе отдаём из пакета emoji-data-ios
        instance.middlewares.use((request, response, next) => {
          const match = /^\/(img-apple-(?:64|160))\/([\w-]+\.png)(?:\?.*)?$/.exec(request.url || '');
          const file = match && path.join(project, 'node_modules', 'emoji-data-ios', match[1], match[2]);
          if (!file || !existsSync(file)) { next(); return; }
          response.setHeader('content-type', 'image/png'); createReadStream(file).pipe(response);
        });
        instance.middlewares.use('/relay-ui-audit', async (_request, response, next) => {
          try {
            const html = await instance.transformIndexHtml('/relay-ui-audit',
              '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
              + '<title>Relay isolated UI audit</title><style>@layer reset, variables, ui, components;</style>'
              + '<script>if (!location.hash) history.replaceState(history.state, "", location.pathname + location.search + "#mockScenario=relay-ui");</script></head>'
              + '<body id="root"><div id="portals"></div><script type="module" src="/scripts/relay-ui-audit.fixture.tsx"></script></body></html>');
            response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
          } catch (error) { next(error); }
        });
      },
    }],
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.config.server.port}/relay-ui-audit#mockScenario=relay-ui` };
}

/** All native effects terminate in this fresh browser; no live IPC or account transport exists. */
export function initializeAuditBrowser() {
  const listeners = new Map();
  const calls = [];
  const switches = [];
  const activeStages = new Set(['queued', 'resolving', 'downloading', 'writing', 'preparing', 'sending', 'cancelling']);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const media = {
    epoch: 0, operations: [], isLocked: true, savedFiles: new Map(), missingFiles: new Set(),
    fileActions: [], sourceActions: [],
    snapshot() {
      return clone({ epoch: media.epoch, operations: media.isLocked ? [] : media.operations, isLocked: media.isLocked });
    },
    publish() { native.emit('relay-media-operation', media.snapshot()); },
    seed(operations, isLocked = false) {
      media.operations = clone(operations); media.isLocked = isLocked; media.epoch += 1;
      for (const operation of operations) {
        for (const file of operation.files || []) media.savedFiles.set(file.path, clone(file));
      }
      media.publish(); return media.snapshot();
    },
    patch(id, patch) {
      const operation = media.operations.find((value) => value.id === id);
      if (!operation) throw new Error('MEDIA_OPERATION_MISSING');
      Object.assign(operation, clone(patch), { revision: operation.revision + 1, updatedAt: Date.now() });
      media.epoch += 1; media.publish(); return media.snapshot();
    },
    emitSnapshot(snapshot) { native.emit('relay-media-operation', clone(snapshot)); },
    get(id) {
      const operation = media.operations.find((value) => value.id === id);
      if (!operation) throw new Error('MEDIA_OPERATION_MISSING');
      return operation;
    },
    action(action) {
      if (action.type === 'lock') {
        media.isLocked = action.isLocked; media.epoch += 1; media.publish(); return media.snapshot();
      }
      if (media.isLocked) throw new Error('MEDIA_JOURNAL_LOCKED');
      if (action.type === 'clear') {
        media.operations = media.operations.filter((operation) => activeStages.has(operation.stage));
      } else if (action.type === 'register') {
        if (media.operations.some((operation) => operation.id === action.operation.id)) throw new Error('MEDIA_OPERATION_EXISTS');
        const now = Date.now();
        media.operations.push({ ...clone(action.operation), attempt: 1, revision: 1, stage: 'queued',
          createdAt: now, updatedAt: now, files: [] });
      } else {
        const operation = media.get(action.id);
        if (action.type === 'open' || action.type === 'reveal') {
          const index = action.index || 0;
          const file = operation.files[index];
          if (!file || !media.savedFiles.has(file.path) || media.missingFiles.has(file.path)) throw new Error('MEDIA_FILE_MISSING');
          media.fileActions.push({ type: action.type, id: operation.id, index, path: file.path });
          return media.snapshot();
        }
        if (action.type === 'remove') {
          if (activeStages.has(operation.stage)) throw new Error('MEDIA_OPERATION_ACTIVE');
          media.operations = media.operations.filter((value) => value.id !== action.id);
        } else if (action.type === 'update') {
          if (action.attempt !== operation.attempt) throw new Error('MEDIA_STALE_ATTEMPT');
          if (action.revision !== operation.revision) throw new Error('MEDIA_STALE_REVISION');
          const patch = clone(action.patch);
          for (const key of ['confirmed', 'total', 'randomIds', 'fingerprints']) {
            if (key in patch && operation.send) { operation.send[key] = patch[key]; delete patch[key]; }
          }
          Object.assign(operation, patch); operation.revision += 1; operation.updatedAt = Date.now();
        } else if (action.type === 'cancel') {
          if (activeStages.has(operation.stage)) {
            operation.stage = 'cancelling'; operation.revision += 1;
            setTimeout(() => {
              const current = media.operations.find((value) => value.id === action.id);
              if (current?.stage === 'cancelling') media.patch(action.id, { stage: 'cancelled', completedAt: Date.now() });
            }, 40);
          }
        } else if (action.type === 'retry') {
          if (!['failed', 'interrupted', 'cancelled'].includes(operation.stage)) throw new Error('MEDIA_OPERATION_TERMINAL');
          operation.attempt += 1; operation.revision += 1; operation.stage = 'queued';
        } else throw new Error('MEDIA_ACTION_UNKNOWN');
      }
      media.epoch += 1; media.publish(); return media.snapshot();
    },
  };
  const windowCallbacks = { resized: new Set(), moved: new Set() };
  const native = window.__relayNativeMock = {
    calls, switches, external: [], failNext: undefined, delay: 15,
    media, contentVisible: true, currentApp: 'telegram', windowCallbacks,
    listen(name, callback) { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set);
      return () => set.delete(callback); },
    emit(name, payload) { for (const callback of listeners.get(name) || []) callback({ payload }); },
    async invoke(command, args) {
      calls.push({ command, args: args === undefined ? undefined : clone(args), contentVisible: native.contentVisible,
        currentApp: native.currentApp, time: performance.now() });
      if (command === native.failNext) { native.failNext = undefined; throw new Error('Synthetic native operation failure'); }
      if (command === 'relay_media_operations_list') return media.snapshot();
      if (command === 'relay_media_operation_action') return media.action(args.action);
      if (command === 'relay_media_operation_revision') {
        const operation = media.get(args.id);
        return { attempt: operation.attempt, revision: operation.revision, stage: operation.stage };
      }
      if (command === 'multi_set_content_visible') { native.contentVisible = args.visible; return undefined; }
      if (command === 'multi_set_active_app') {
        if (!native.contentVisible) throw new Error('MEDIA_OPERATIONS_OPEN');
        await new Promise((resolve) => setTimeout(resolve, native.delay));
        switches.push(args.app); native.currentApp = args.app;
        if (args.app !== 'telegram') native.emit(args.app === 'x' ? 'multi-x-status' : 'multi-instagram-status', { state: 'ready' });
      }
      if (command === 'relay_media_operation_source') {
        if (media.isLocked) throw new Error('MEDIA_JOURNAL_LOCKED');
        const operation = media.get(args.id);
        if (!native.contentVisible) throw new Error('MEDIA_OPERATIONS_OPEN');
        if (native.currentApp !== operation.service) throw new Error('MEDIA_SOURCE_SERVICE_INACTIVE');
        const patterns = { x: /^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+$/,
          instagram: /^https:\/\/www\.instagram\.com\/(?:p|reel)\/[^/]+\/$/,
          telegram: /^https:\/\/t\.me\/[^/]+\/\d+$/ };
        if (!patterns[operation.service]?.test(operation.sourceUrl || '')) throw new Error('MEDIA_SOURCE_INVALID');
        media.sourceActions.push({ id: operation.id, service: operation.service, url: operation.sourceUrl });
        return undefined;
      }
      if (command === 'multi_social_download_media' || command === 'multi_social_save_media'
        || command === 'relay_media_download_prepare') throw new Error('MEDIA_AUDIT_RUNTIME_UNAVAILABLE');
      if (command === 'relay_get_telegram_transport') return {};
      if (command === 'relay_research_bridge_ready') return true;
      if (command === 'multi_x_begin_direct_login') return true;
      return undefined;
    },
    currentWindow: {
      innerSize: async () => ({ width: window.innerWidth * window.devicePixelRatio, height: window.innerHeight * window.devicePixelRatio }),
      scaleFactor: async () => window.devicePixelRatio, isMaximized: async () => false, isFullscreen: async () => false, setFullscreen: async () => {},
      minimize: async () => calls.push({ command: 'window:minimize' }),
      toggleMaximize: async () => calls.push({ command: 'window:toggleMaximize' }),
      close: async () => calls.push({ command: 'window:close' }),
      onResized: async (callback) => { windowCallbacks.resized.add(callback); return () => windowCallbacks.resized.delete(callback); },
      onMoved: async (callback) => { windowCallbacks.moved.add(callback); return () => windowCallbacks.moved.delete(callback); },
      startDragging: async () => calls.push({ command: 'window:startDragging' }),
    },
  };
  window.addEventListener('resize', () => {
    for (const callback of windowCallbacks.resized) callback({ payload: { width: window.innerWidth, height: window.innerHeight } });
  });
  window.isTauri = true; window.isCompatTestPassed = true;
  window.__relayUnhandled = [];
  window.addEventListener('unhandledrejection', (event) => window.__relayUnhandled.push(String(event.reason)));
}
