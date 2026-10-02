import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startAuditServer } from './relay-ui-audit.server.mjs';
export async function startComposerMediaServer(output, port = 1253) {
    const { server } = await startAuditServer(output, port);
    const counts = { retry: 0, loading: 0, success: 0 };
    server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/composer-owned/reader') {
            const mode = url.searchParams.get('mode');
            if (!Object.hasOwn(counts, mode)) {
                response.statusCode = 400;
                response.end();
                return;
            }
            counts[mode] += 1;
            if (mode === 'retry' && counts.retry === 1) {
                response.statusCode = 503;
                response.end('Owned synthetic unavailable');
                return;
            }
            if (mode === 'loading')
                await new Promise(resolve => setTimeout(resolve, 750));
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.end(await readFile(path.join(output, 'owned-research.txt')));
            return;
        }
        if (url.pathname !== '/relay-composer-media') {
            next();
            return;
        }
        try {
            const html = await server.transformIndexHtml('/relay-composer-media', '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owned Relay composer media audit</title><style>@layer reset, variables, ui, components;</style></head><body id="root"><div id="portals"></div><script type="module" src="/scripts/relay-composer-media.fixture.tsx"></script></body></html>');
            response.setHeader('content-type', 'text/html; charset=utf-8');
            response.end(html);
        }
        catch (error) {
            next(error);
        }
    });
    server.middlewares.stack.unshift(server.middlewares.stack.pop());
    return { server, counts, url: `http://127.0.0.1:${server.config.server.port}/relay-composer-media#mockScenario=relay-ui` };
}
