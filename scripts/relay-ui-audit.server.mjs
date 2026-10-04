import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startAuditServer(output, port = 1251) {
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
      load(id) { return id.startsWith('\0relay-audit:') ? mockModules.get(id.slice('\0relay-audit:'.length)) : undefined; },
      configureServer(instance) {
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
  const native = window.__relayNativeMock = { calls, switches, external: [], failNext: undefined, delay: 15,
    listen(name, callback) { const set = listeners.get(name) || new Set(); set.add(callback); listeners.set(name, set);
      return () => set.delete(callback); },
    emit(name, payload) { for (const callback of listeners.get(name) || []) callback({ payload }); },
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === native.failNext) { native.failNext = undefined; throw new Error('Synthetic native operation failure'); }
      if (command === 'multi_set_active_app') {
        await new Promise((resolve) => setTimeout(resolve, native.delay)); switches.push(args.app);
        if (args.app !== 'telegram') native.emit(args.app === 'x' ? 'multi-x-status' : 'multi-instagram-status', { state: 'ready' });
      }
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
      onResized: async () => () => {}, onMoved: async () => () => {},
      startDragging: async () => calls.push({ command: 'window:startDragging' }),
    },
  };
  window.isTauri = true; window.isCompatTestPassed = true;
  window.__relayUnhandled = [];
  window.addEventListener('unhandledrejection', (event) => window.__relayUnhandled.push(String(event.reason)));
}




