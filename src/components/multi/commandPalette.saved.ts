import type { PaletteEntry, PalettePayload } from './commandPalette.index';
import type { LibraryEntry } from './mediaLibrarySource';

import { getSourceUrl } from './mediaLibrarySource';

type SavedFormat = {
  getServiceTitle: (service: LibraryEntry['service']) => string;
  formatDate: (timestamp: number) => string;
};

export function buildSavedEntries(
  saved: readonly LibraryEntry[],
  { getServiceTitle, formatDate }: SavedFormat,
): PaletteEntry<PalettePayload>[] {
  const entries: PaletteEntry<PalettePayload>[] = [];
  for (const item of saved.toSorted((first, second) => second.savedAt - first.savedAt)) {
    const source = getSourceUrl(item);
    if ((item.isLink && !source) || !item.fileName) continue;
    const payload: PalettePayload = item.isLink && source
      ? { type: 'libraryLink', url: source, service: item.service } : { type: 'libraryFile', id: item.id };
    const url = source ? new URL(source) : undefined;
    const service = getServiceTitle(item.service);
    entries.push({
      id: `saved:${item.id}`,
      group: 'saved',
      title: item.isLink ? source! : item.fileName,
      subtitle: [service, url?.hostname, formatDate(item.savedAt)].filter(Boolean).join(' · '),
      keywords: [service, url?.hostname, url?.pathname].filter((value): value is string => Boolean(value)),
      payload,
    });
  }
  return entries;
}
