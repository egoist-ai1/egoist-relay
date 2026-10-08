import { startAuditServer } from './relay-ui-audit.server.mjs';
export async function startPaymentServer(output, port = 1254) {
  const { server } = await startAuditServer(output, port);
  server.middlewares.use('/relay-payment-modal-audit', async (_request, response, next) => {
    try {
      const html = await server.transformIndexHtml('/relay-payment-modal-audit',
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>Isolated Relay payment component proof</title><style>@layer reset, variables, ui, components;</style></head>'
        + '<body id="root"><div id="portals"></div><script type="module" src="/scripts/relay-payment-modal.fixture.tsx"></script></body></html>');
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html);
    } catch (error) { next(error); }
  });
  server.middlewares.stack.unshift(server.middlewares.stack.pop());
  return { server, url: 'http://127.0.0.1:' + server.config.server.port + '/relay-payment-modal-audit#mockScenario=relay-ui' };
}

