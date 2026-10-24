import type { PaletteEntry, PalettePayload } from './commandPalette.index';
import type { MediaOperation } from './mediaOperations.types';

type SavedFormat = {
  getServiceTitle: (service: MediaOperation['service']) => string;
  formatDate: (timestamp: number) => string;
};

// Адрес источника без query и fragment: в них бывают токены и идентификаторы сессии
function getSourceParts(sourceUrl?: string) {
  if (!sourceUrl) return {};
  try {
    const url = new URL(sourceUrl);
    return { host: url.hostname, path: url.pathname === '/' ? '' : url.pathname };
  } catch {
    return {};
  }
}

/** Сохранённое из журнала: только завершённые `save` и `download`, свежие первыми. Полный путь файла не попадает в индекс. */
export function buildSavedEntries(
  operations: MediaOperation[],
  { getServiceTitle, formatDate }: SavedFormat,
): PaletteEntry<PalettePayload>[] {
  const completed = operations
    .filter((operation) => (operation.kind === 'save' || operation.kind === 'download')
      && operation.stage === 'completed' && operation.files.length > 0)
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));

  const entries: PaletteEntry<PalettePayload>[] = [];
  for (const operation of completed) {
    const serviceTitle = getServiceTitle(operation.service);
    const { host, path } = getSourceParts(operation.sourceUrl);
    const date = formatDate(operation.completedAt ?? operation.updatedAt);
    operation.files.forEach((file, index) => {
      if (!file.fileName) return;
      entries.push({
        id: `${operation.id}:${index}`,
        group: 'saved',
        title: file.fileName,
        subtitle: [serviceTitle, host, date].filter(Boolean).join(' · '),
        keywords: [serviceTitle, host, path, operation.fileName].filter((value): value is string => Boolean(value)),
        payload: { type: 'file', operationId: operation.id, index },
      });
    });
  }
  return entries;
}
