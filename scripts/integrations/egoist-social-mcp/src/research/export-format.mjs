// Human-readable derivatives of accepted records. records.jsonl is authoritative.
// This module never fetches URLs, infers hidden fields or changes provider records.
const textFieldNames = new Set(['text', 'caption', 'description', 'observedText', 'title']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function invalidTextFields() { throw Object.assign(new Error('Invalid text field ranges.'), { code: 'INVALID_TEXT_FIELDS' }); }
function utf16Boundary(text, offset) {
  return offset === 0 || offset === text.length
    || !(text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
      && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF);
}
export function restoreResearchTextFields(record, payload = record.text) {
  if (record.textFields === undefined) return record;
  if (!object(record.textFields) || typeof payload !== 'string' || Buffer.byteLength(payload) > 4 * 1024 ** 2) invalidTextFields();
  const entries = Object.entries(record.textFields);
  if (!entries.length || entries.length > textFieldNames.size) invalidTextFields();
  const result = { ...record };
  delete result.text; delete result.textFields;
  const ranges = [];
  for (const [field, range] of entries) {
    if (!textFieldNames.has(field) || !object(range) || Object.keys(range).length !== 2
      || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
      || range.offset < 0 || range.length < 0 || range.offset + range.length > payload.length
      || !utf16Boundary(payload, range.offset) || !utf16Boundary(payload, range.offset + range.length)) invalidTextFields();
    const value = payload.slice(range.offset, range.offset + range.length);
    if (field !== 'text' && record[field] !== undefined && record[field] !== value) invalidTextFields();
    result[field] = value;
    ranges.push([range.offset, range.offset + range.length]);
  }
  // Exact aliases are allowed; partial overlap and unassigned payload bytes are not.
  const unique = [...new Map(ranges.map(range => [range.join(':'), range])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique[0][0] !== 0) invalidTextFields();
  let end = 0;
  for (const range of unique) {
    if (range[0] < end || (range[0] > end && payload.slice(end, range[0]) !== '\n')) invalidTextFields();
    end = range[1];
  }
  if (end !== payload.length) invalidTextFields();
  return result;
}
export function isPageDescription(record) {
  return record.provider === 'instagram' && ['post', 'reel'].includes(record.type)
    && object(record.pageMetadata) && record.pageMetadata.descriptionField === 'description';
}
const htmlEscape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const markdownEscape = value => String(value).replace(/[\\`*_{}[\]()#+.!|><&~-]/g, character => '\\' + character).replace(/[\r\n]/g, ' ');
const plain = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function linkTarget(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    // Preserve observed signed query values; encode only delimiters unsafe in Markdown.
    return value.replace(/[<>"\\]/g, character => encodeURIComponent(character));
  } catch { return undefined; }
}
function markdownLink(label, target) {
  const safe = linkTarget(target);
  return safe ? '[' + markdownEscape(label) + '](<' + safe + '>)' : markdownEscape(label) + ': ' + markdownEscape(plain(target));
}
function htmlLink(label, target) {
  const safe = linkTarget(target);
  return safe ? '<a href="' + htmlEscape(safe) + '" rel="noreferrer noopener">' + htmlEscape(label) + '</a>' : htmlEscape(label) + ': ' + htmlEscape(plain(target));
}
function literalMarkdown(value) {
  return String(value).replace(/\r\n?/g, '\n').split('\n').map(line => '    ' + line).join('\n');
}
function bodyFields(record) {
  const fields = [];
  const seen = new Set();
  const add = (label, value) => {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) return;
    seen.add(value); fields.push({ label, value });
  };
  for (const [key, label] of [['text', 'Текст'], ['caption', 'Подпись'], ['description', 'Описание страницы'], ['observedText', 'Наблюдаемый текст']]) {
    if (key !== 'description' || !isPageDescription(record)) add(label, record[key]);
  }
  if (Array.isArray(record.descriptions)) for (const value of record.descriptions) add('Описание изображения', value);
  return fields;
}
function recordMetadata(record, ordinal) {
  const values = [['Запись JSONL', String(ordinal)], ['Тип', plain(record.type)], ['ID', plain(record.id)]];
  const author = typeof record.author === 'string' ? record.author : plain(record.author?.observedText || record.author?.name || record.author?.username);
  if (author) values.push(['Наблюдаемый автор', author]);
  if (typeof record.timestamp === 'string' && record.timestamp) values.push(['Время источника', record.timestamp]);
  else if (Number.isFinite(record.date) && Number.isInteger(record.date)) {
    const date = new Date(record.date * 1000);
    if (!Number.isNaN(date.valueOf())) values.push(['Время источника UTC', date.toISOString()]);
  }
  if (record.observedAt) values.push(['Наблюдалось', plain(record.observedAt)]);
  if (record.sourceContext?.pageUrl) values.push(['Страница наблюдения', plain(record.sourceContext.pageUrl)]);
  if (record.sourceContext?.requestedSource) values.push(['Выбранный источник', plain(record.sourceContext.requestedSource)]);
  if (record.sourceLocator) values.push(['Локатор источника', plain(record.sourceLocator)]);
  return values.filter(([, value]) => value);
}
function observedLinks(record) {
  return Array.isArray(record.links) ? record.links.filter(item => item && typeof item.url === 'string').map(item => ({ label: plain(item.text) || 'Ссылка', url: item.url })) : [];
}
function observedMedia(record) {
  if (!Array.isArray(record.media)) return [];
  return record.media.filter(item => item && typeof item === 'object').map((item, index) => ({
    label: [String(index + 1) + '. ' + (plain(item.kind) || 'Медиа'), plain(item.description)].filter(Boolean).join(' — '),
    sourceUrl: plain(item.sourceUrl), posterUrl: plain(item.posterUrl),
    dimensions: Number.isFinite(item.width) && Number.isFinite(item.height) ? item.width + ' × ' + item.height + ' (наблюдаемые размеры)' : '',
  }));
}
function localMedia(manifest) {
  return Array.isArray(manifest) ? manifest.filter(item => item && /^media-[0-9]{3,}-[a-f0-9]{16}\.[a-z0-9]+$/.test(item.file ?? '')).map(item => ({
    file: item.file, bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : undefined,
    sha256: /^[a-f0-9]{64}$/.test(item.sha256 ?? '') ? item.sha256 : undefined, mimeType: plain(item.mimeType),
  })) : [];
}
function coverageDetails(record) {
  const details = [];
  if (isPageDescription(record) && typeof record.description === 'string') {
    details.push({ label: 'Метаданные наблюдаемой страницы', value: record.description });
  }
  for (const [key, label] of [['unresolvedFields', 'Не наблюдалось / ограничения'], ['omittedFields', 'Намеренно исключённые поля']]) {
    if (Array.isArray(record[key]) && record[key].length) details.push({ label, value: record[key].filter(value => typeof value === 'string').join('\n') });
  }
  if (record.metrics && typeof record.metrics === 'object' && Object.keys(record.metrics).length) details.push({ label: 'Наблюдаемые показатели', value: JSON.stringify(record.metrics, null, 2) });
  return details;
}
function exportStatus(partial) {
  return partial ? 'Частичный результат — продолжение или недоступные данные указаны в export-manifest.json.' : 'Выбранное задание завершено.';
}
function title(record) { return plain(record.title) || plain(record.id) || plain(record.type) || 'Запись'; }
function headerValues({ provider, operation, jobId, records, coverage }) {
  return [['Сервис', provider], ['Операция', operation], ['Задание', jobId], ['Записей', records.length], ...(coverage ? [['Область', coverage]] : [])];
}

export function formatResearchMarkdown(options) {
  const { records, manifest = [], partial = false } = options;
  const chunks = ['# Экспорт социального исследования', '', exportStatus(partial), 'Полнота источника не установлена.', '', ...headerValues(options).map(([label, value]) => '- ' + label + ': ' + markdownEscape(value)), '', 'Полные принятые поля: [records.jsonl](records.jsonl). Номер записи соответствует строке JSONL.', 'Условия чтения и ограничения: [export-manifest.json](export-manifest.json).', ''];
  records.forEach((rawRecord, index) => {
    const record = restoreResearchTextFields(rawRecord);
    chunks.push('## ' + markdownEscape(title(record)), '', ...recordMetadata(record, index + 1).map(([label, value]) => '- ' + label + ': ' + markdownEscape(value)), '');
    const source = record.sourceUrl ?? record.source;
    if (source) chunks.push(markdownLink('Источник', source), '');
    const fields = bodyFields(record);
    if (!fields.length) chunks.push('Текст в принятой записи не наблюдался.', '');
    for (const field of fields) chunks.push('### ' + field.label, '', literalMarkdown(field.value), '');
    const links = observedLinks(record);
    if (links.length) chunks.push('### Наблюдаемые ссылки', '', ...links.map(item => '- ' + markdownLink(item.label, item.url)), '');
    const media = observedMedia(record);
    if (media.length) chunks.push('### Наблюдаемое медиа', '');
    for (const item of media) {
      chunks.push('- ' + (item.sourceUrl ? markdownLink(item.label, item.sourceUrl) : markdownEscape(item.label)), '');
      if (item.posterUrl && item.posterUrl !== item.sourceUrl) chunks.push(markdownLink('Постер', item.posterUrl), '');
      if (item.dimensions) chunks.push(markdownEscape(item.dimensions), '');
    }
    for (const detail of coverageDetails(record)) chunks.push('### ' + detail.label, '', literalMarkdown(detail.value), '');
  });
  const local = localMedia(manifest);
  if (local.length) chunks.push('## Скачанные файлы', '', 'Локальные файлы, принятые текущим заданием. Ссылки не обращаются к сети.', '');
  for (const item of local) {
    chunks.push('- [' + item.file + '](' + item.file + ')', '');
    if (item.bytes !== undefined) chunks.push('Байт: ' + item.bytes);
    if (item.mimeType) chunks.push('MIME: ' + markdownEscape(item.mimeType));
    if (item.sha256) chunks.push('SHA-256: ' + item.sha256);
    chunks.push('');
  }
  return chunks.join('\n') + '\n';
}

export function formatResearchHtml(options) {
  const { records, manifest = [], partial = false } = options;
  const metadata = values => '<dl>' + values.map(([label, value]) => '<div><dt>' + htmlEscape(label) + '</dt><dd>' + htmlEscape(value) + '</dd></div>').join('') + '</dl>';
  const body = records.map((rawRecord, index) => {
    const record = restoreResearchTextFields(rawRecord);
    const fields = bodyFields(record);
    const source = record.sourceUrl ?? record.source;
    const links = observedLinks(record);
    const media = observedMedia(record);
    return '<article id="record-' + (index + 1) + '"><h2>' + htmlEscape(title(record)) + '</h2>' + metadata(recordMetadata(record, index + 1))
      + (source ? '<p>' + htmlLink('Источник', source) + '</p>' : '')
      + (fields.length ? fields.map(field => '<section><h3>' + htmlEscape(field.label) + '</h3><pre>' + htmlEscape(field.value) + '</pre></section>').join('') : '<p>Текст в принятой записи не наблюдался.</p>')
      + (links.length ? '<section><h3>Наблюдаемые ссылки</h3><ul>' + links.map(item => '<li>' + htmlLink(item.label, item.url) + '</li>').join('') + '</ul></section>' : '')
      + (media.length ? '<section><h3>Наблюдаемое медиа</h3><ul>' + media.map(item => '<li>' + (item.sourceUrl ? htmlLink(item.label, item.sourceUrl) : htmlEscape(item.label))
        + (item.posterUrl && item.posterUrl !== item.sourceUrl ? '<p>' + htmlLink('Постер', item.posterUrl) + '</p>' : '') + (item.dimensions ? '<p>' + htmlEscape(item.dimensions) + '</p>' : '') + '</li>').join('') + '</ul></section>' : '')
      + coverageDetails(record).map(detail => '<details><summary>' + htmlEscape(detail.label) + '</summary><pre>' + htmlEscape(detail.value) + '</pre></details>').join('') + '</article>';
  }).join('');
  const local = localMedia(manifest);
  const files = local.length ? '<section><h2>Скачанные файлы</h2><p>Локальные файлы, принятые текущим заданием. Ссылки не обращаются к сети.</p><ul>' + local.map(item => '<li><a href="' + item.file + '" download>' + item.file + '</a>'
    + metadata([...(item.bytes !== undefined ? [['Байт', item.bytes]] : []), ...(item.mimeType ? [['MIME', item.mimeType]] : []), ...(item.sha256 ? [['SHA-256', item.sha256]] : [])]) + '</li>').join('') + '</ul></section>' : '';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>Экспорт социального исследования</title><style>body{max-width:86ch;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui;color:#18181b;background:#fafafa}h1,h2,h3{line-height:1.25;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}article{border-bottom:1px solid #d4d4d8;padding:1rem 0}a,dd,li{overflow-wrap:anywhere}dl{margin:1rem 0}dl div{display:flex;flex-wrap:wrap;gap:.25rem .75rem}dt{font-weight:600}dd{margin:0;min-width:0}details{margin:1rem 0}summary{cursor:pointer;font-weight:600}li p{margin:.25rem 0}@media(max-width:480px){body{margin:1rem auto}dl div{display:block}dd{margin-bottom:.5rem}}</style></head><body><header><h1>Экспорт социального исследования</h1><p>' + htmlEscape(exportStatus(partial)) + '</p><p>Полнота источника не установлена.</p>'
    + metadata(headerValues(options)) + '<p>Полные принятые поля: <a href="records.jsonl">records.jsonl</a>. Номер записи соответствует строке JSONL.</p><p>Условия чтения и ограничения: <a href="export-manifest.json">export-manifest.json</a>.</p></header><main>' + body + files + '</main></body></html>\n';
}
