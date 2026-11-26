import type { MediaWorkerApi } from '../lib/mediaWorker/index.worker';
import type { Connector } from './PostMessageConnector';

import { createConnector } from './PostMessageConnector';

export const MAX_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 4);

const connectors: (Connector<MediaWorkerApi> | undefined)[] = [];

export function requestMediaWorker(payload: Parameters<Connector<MediaWorkerApi>['request']>[0], index: number) {
  let connector = connectors[index];
  if (!connector) {
    const worker = new Worker(new URL('../lib/mediaWorker/index.worker.ts', import.meta.url), { type: 'module' });
    connector = createConnector<MediaWorkerApi>(worker, undefined, 'media');
    connectors[index] = connector;
  }
  return connector.request(payload);
}
