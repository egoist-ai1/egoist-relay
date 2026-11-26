// Источники исследования: каноническая форма ссылки/handle и чтение списка из файла рабочей папки.
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeFile } from './job-store.mjs';
import { OrchError, fail, looksSecret, safeEcho, sha256 } from './orch-core.mjs';

const HOSTS = {
  telegram: new Set(['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']),
  x: new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']),
  instagram: new Set(['instagram.com', 'www.instagram.com']),
};
const PROVIDER_ALIASES = { telegram: 'telegram', tg: 'telegram', x: 'x', twitter: 'x', instagram: 'instagram', ig: 'instagram' };
export const PROVIDERS = Object.freeze(['telegram', 'x', 'instagram']);
const X_RESERVED = new Set(['i', 'home', 'search', 'hashtag', 'explore', 'settings', 'messages', 'notifications', 'compose', 'intent', 'share', 'login', 'signup']);
const TELEGRAM_RESERVED = new Set(['joinchat', 'addstickers', 'addemoji', 'share', 'proxy', 'socks', 'login', 'setlanguage', 'bg', 'iv', 'invoice', 'boost']);

export const MAX_SOURCE_FILE_BYTES = 16 * 1024 ** 2;
export const MAX_SOURCE_FILE_ROWS = 50000;

function invalid(reason) { throw new OrchError('INVALID_INPUT', reason); }

function parseUrl(provider, text) {
  let url;
  try { url = new URL(text); } catch { invalid('source_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS[provider].has(url.hostname.toLowerCase())) invalid('source_url_not_first_party_https');
  return url.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { invalid('source_url_invalid'); } });
}

/** Возвращает { provider, canonical, ref, kind } либо бросает INVALID_INPUT с короткой причиной. */
export function canonicalSource(provider, ref, kindHint) {
  if (!PROVIDERS.includes(provider)) invalid('provider_unknown');
  if (typeof ref !== 'string') invalid('source_ref_invalid');
  let text = ref.trim();
  if (/^(?:www\.)?(?:t\.me|telegram\.me|x\.com|twitter\.com|instagram\.com)\//i.test(text)) text = 'https://' + text;
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) invalid('source_ref_invalid');
  if (looksSecret(text)) invalid('source_ref_has_credential_marker');
  const make = (canonical, bridgeRef, kind) => ({ provider, canonical, ref: bridgeRef, kind: kindHint && compatibleKind(provider, kind, kindHint) ? kindHint : kind });
  if (text.startsWith('https://') || text.startsWith('http://')) {
    const parts = parseUrl(provider, text);
    if (provider === 'telegram') {
      if (!parts.length) invalid('source_url_without_path');
      if (parts[0] === 's' && parts.length === 2) parts.shift();
      if (parts[0] === 'c' && parts.length === 2 && /^\d{1,15}$/.test(parts[1])) return make(`peer:-100${parts[1]}`, `-100${parts[1]}`, 'channel');
      if (parts[0] === 'c' && parts.length === 3 && /^\d{1,15}$/.test(parts[1]) && /^\d{1,12}$/.test(parts[2])) return make(`peer:-100${parts[1]}/${parts[2]}`, text, 'post');
      if (parts[0].startsWith('+') || TELEGRAM_RESERVED.has(parts[0].toLowerCase())) invalid('invite_link_needs_explicit_join');
      if (!/^[A-Za-z0-9_.]{1,128}$/.test(parts[0])) invalid('source_url_not_a_source');
      if (parts.length === 1) return make('@' + parts[0].toLowerCase(), '@' + parts[0], 'channel');
      if (parts.length === 2 && /^\d{1,12}$/.test(parts[1])) return make(`@${parts[0].toLowerCase()}/${parts[1]}`, text, 'post');
      invalid('source_url_not_a_source');
    }
    if (provider === 'x') {
      if (!parts.length || X_RESERVED.has(parts[0].toLowerCase()) || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0])) invalid('source_url_not_a_source');
      if (parts.length === 1) return make('@' + parts[0].toLowerCase(), '@' + parts[0], 'profile');
      if (parts.length === 3 && parts[1] === 'status' && /^\d{1,25}$/.test(parts[2])) return make(`x:status:${parts[2]}`, text, 'post');
      invalid('source_url_not_a_source');
    }
    if (parts[0] === 'explore' && parts[1] === 'tags' && /^[\p{L}\p{N}_]{1,100}$/u.test(parts[2] ?? '')) return make('#' + parts[2].toLowerCase(), '#' + parts[2], 'hashtag');
    if ((parts[0] === 'p' || parts[0] === 'reel') && /^[A-Za-z0-9_-]{5,32}$/.test(parts[1] ?? '')) return make(`ig:${parts[0]}:${parts[1]}`, text, 'post');
    if (parts.length >= 1 && /^[A-Za-z0-9_.]{1,30}$/.test(parts[0]) && !['explore', 'accounts', 'direct', 'stories', 'reels', 'p', 'reel'].includes(parts[0]) && parts.length === 1) return make('@' + parts[0].toLowerCase(), '@' + parts[0], 'profile');
    invalid('source_url_not_a_source');
  }
  if (/^-?\d{1,20}$/.test(text)) {
    if (provider !== 'telegram') invalid('numeric_id_only_for_telegram');
    return make(`peer:${text}`, text, 'channel');
  }
  if (text.startsWith('#')) {
    if (provider !== 'instagram' || !/^#[\p{L}\p{N}_]{1,100}$/u.test(text)) invalid('hashtag_only_for_instagram');
    return make(text.toLowerCase(), text, 'hashtag');
  }
  const handle = text.replace(/^@/, '');
  const pattern = provider === 'telegram' ? /^[A-Za-z0-9_.]{1,128}$/ : provider === 'x' ? /^[A-Za-z0-9_]{1,15}$/ : /^[A-Za-z0-9_.]{1,30}$/;
  if (!pattern.test(handle)) invalid('source_handle_invalid');
  return make('@' + handle.toLowerCase(), '@' + handle, provider === 'telegram' ? 'channel' : 'profile');
}

function compatibleKind(provider, derived, hint) {
  if (derived === hint) return true;
  if (provider === 'telegram') return derived === 'channel' && hint === 'group';
  return false;
}

/** Какие виды источников этап 1 умеет читать как историю. */
export function supportsHistory(source) {
  return (source.provider === 'telegram' && ['channel', 'group'].includes(source.kind))
    || (source.provider === 'x' && source.kind === 'profile')
    || (source.provider === 'instagram' && ['profile', 'hashtag'].includes(source.kind));
}

export function providerFromText(text) {
  const match = /^([a-z]+)[:\s]\s*(.+)$/i.exec(text);
  if (match && PROVIDER_ALIASES[match[1].toLowerCase()] && !/^[a-z]+:\/\//i.test(text)) return { provider: PROVIDER_ALIASES[match[1].toLowerCase()], ref: match[2].trim() };
  if (/^(?:https?:\/\/|(?:www\.)?(?:t\.me|telegram\.me|x\.com|twitter\.com|instagram\.com)\/)/i.test(text)) {
    try {
      const host = new URL(/^https?:/i.test(text) ? text : 'https://' + text).hostname.toLowerCase();
      for (const [provider, hosts] of Object.entries(HOSTS)) if (hosts.has(host)) return { provider, ref: text };
    } catch { /* ниже будет отказ с причиной */ }
  }
  return undefined;
}

function parseCsvLine(line) {
  const cells = []; let cell = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',' || char === ';' || char === '\t') { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  return cells.map(value => value.trim());
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/**
 * Читает .txt/.csv/.jsonl внутри рабочей папки. Возвращает { rows, rejected } без обращения к сети и аккаунтам.
 * Файл не меняется; ссылки, hardlink и junction в пути отклоняются.
 */
export async function readSourceFile(file, { workspaceRoot }) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('INVALID_INPUT', 'sourceFile must be an absolute path inside the workspace.');
  const target = path.resolve(file);
  const extension = path.extname(target).toLowerCase();
  if (!['.txt', '.csv', '.jsonl'].includes(extension)) fail('INVALID_INPUT', 'sourceFile must be .txt, .csv or .jsonl.');
  if (!workspaceRoot || !within(path.resolve(workspaceRoot), target)) fail('INVALID_INPUT', 'sourceFile must be inside the workspace folder.');
  let info;
  try { info = await assertSafeFile(target); } catch { fail('INVALID_INPUT', 'sourceFile is missing or is not a plain private file.'); }
  if (info.size > MAX_SOURCE_FILE_BYTES) fail('INVALID_INPUT', 'sourceFile is larger than 16 MiB.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(target)); } catch (error) { if (error instanceof OrchError) throw error; fail('INVALID_INPUT', 'sourceFile is not valid UTF-8 text.'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > MAX_SOURCE_FILE_ROWS + 2) fail('INVALID_INPUT', `sourceFile has more than ${MAX_SOURCE_FILE_ROWS} rows.`);
  const rows = []; const rejected = [];
  const reject = (line, reason) => { if (rejected.length < 200) rejected.push({ line, reason }); };
  let header;
  lines.forEach((raw, index) => {
    const line = index + 1;
    const content = raw.trim();
    if (!content || content.startsWith('#') && extension === '.txt') return;
    try {
      if (extension === '.jsonl') {
        let value; try { value = JSON.parse(content); } catch { reject(line, 'json_invalid'); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { reject(line, 'json_not_object'); return; }
        rows.push({ provider: value.provider, ref: value.ref, kind: value.kind, label: value.label, line });
      } else if (extension === '.csv') {
        const cells = parseCsvLine(content);
        const lower = cells.map(cell => cell.toLowerCase());
        if (!header && rows.length === 0 && lower.includes('ref') && lower.includes('provider')) { header = lower; return; }
        const pick = name => header ? cells[header.indexOf(name)] : cells[['provider', 'ref', 'kind', 'label'].indexOf(name)];
        const provider = pick('provider')?.toLowerCase();
        rows.push({ provider: PROVIDER_ALIASES[provider] ?? provider, ref: pick('ref'), kind: pick('kind') || undefined, label: pick('label') || undefined, line });
      } else {
        const parsed = providerFromText(content);
        if (!parsed) { reject(line, 'provider_unknown'); return; }
        rows.push({ ...parsed, line });
      }
    } catch (error) { reject(line, error instanceof OrchError ? error.message : 'line_invalid'); }
  });
  return { rows, rejected, fileSha256: sha256(text) };
}

/** Приводит строки к каноническим источникам: дубликаты считаются, невалидные перечисляются без эха секретов. */
export function resolveSources(rows) {
  const unique = new Map(); const invalidList = []; let duplicates = 0;
  for (const row of rows) {
    try {
      const provider = PROVIDER_ALIASES[String(row.provider ?? '').toLowerCase()];
      if (!provider) throw new OrchError('INVALID_INPUT', 'provider_unknown');
      const source = canonicalSource(provider, row.ref, row.kind);
      const label = typeof row.label === 'string' && row.label.trim() && !looksSecret(row.label) ? row.label.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128) : undefined;
      const key = `${source.provider}\u0000${source.canonical}`;
      if (unique.has(key)) { duplicates++; continue; }
      unique.set(key, { ...source, ...(label ? { label } : {}) });
    } catch (error) {
      invalidList.push({ ref: safeEcho(String(row.ref ?? ''), 80), reason: error instanceof OrchError ? error.message.slice(0, 80) : 'source_invalid', ...(row.line ? { line: row.line } : {}) });
    }
  }
  return { sources: [...unique.values()], invalid: invalidList, duplicates };
}

/** Каноническая цель вступления для сравнения с allowedTargets политики. */
export function canonicalJoinTarget(text) {
  try {
    if (typeof text === 'string' && /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(text.trim())) return 'invite:' + text.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
    return canonicalSource('telegram', String(text ?? '')).canonical;
  } catch { return undefined; }
}
