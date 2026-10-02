import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startAuditServer, project } from './relay-ui-audit.server.mjs';

export async function startReelReceiverServer(output, port = 1261) {
  const { server } = await startAuditServer(output, port);
  const sourceFile = 'src/api/gramjs/worker/connector.ts';
  const source = await readFile(path.join(project, sourceFile), 'utf8');
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const apiBoundary = { sourceFile, sourceSha256: sha(source), opcodeWhitelist: ['sendMessageLocal', 'sendMessage'], requiresSocialShareRandomId: true, original: 'function callApi(fnName, ...args) {', replacement: 'function callApi(fnName, ...args) {\n  if (typeof window !== "undefined" && window.__reelShareApi && ["sendMessageLocal", "sendMessage"].includes(fnName) && args[0]?.socialShareRandomId) return window.__reelShareApi(fnName, ...args);', compiledExactCount: undefined, compiledSha256: undefined, servedSha256: undefined };
  server.middlewares.use(async (request, response, next) => {
    try {
      const pathname = request.url?.split('?')[0];
      if (pathname === '/' + sourceFile) {
        const transformed = await server.transformRequest(request.url);
        if (!transformed) throw new Error('Connector compile missing');
        apiBoundary.compiledExactCount = transformed.code.split(apiBoundary.original).length - 1;
        if (apiBoundary.compiledExactCount !== 1) throw new Error('API transport boundary must match exactly once');
        const code = transformed.code.replace(apiBoundary.original, apiBoundary.replacement);
        apiBoundary.compiledSha256 = sha(transformed.code); apiBoundary.servedSha256 = sha(code);
        response.setHeader('content-type', 'application/javascript'); response.end(code); return;
      }
      if (pathname === '/relay-social-share-reels') {
        const html = await server.transformIndexHtml('/relay-social-share-reels', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay real receiver fixture</title><style>@layer reset, variables, ui, components;</style></head><body id="root"><div id="portals"></div><script type="module" src="/scripts/relay-social-share-reels.fixture.tsx"></script></body></html>');
        response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return;
      }
      next();
    } catch (error) { next(error); }
  });
  server.middlewares.stack.unshift(server.middlewares.stack.pop());
  return { server, apiBoundary, url: `http://127.0.0.1:${port}/relay-social-share-reels#mockScenario=relay-ui` };
}
