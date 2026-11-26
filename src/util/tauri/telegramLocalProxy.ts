const MIN_LOCAL_PROXY_PORT = 1024;
const MAX_LOCAL_PROXY_PORT = 65535;
// Windows ShellExecute can add a slash before the query of a protocol link.
const LOCAL_PROXY_LINK = /^tg:\/\/proxy\/?\?[^\s#]+$/i;
const LOCAL_PROXY_QUERY_KEYS = new Set(['server', 'port', 'secret']);

export type TelegramLocalProxyLink = { url: string; port: number };

export function parseTelegramLocalProxyLink(value: string): TelegramLocalProxyLink | undefined {
  if (!LOCAL_PROXY_LINK.test(value)) return undefined;
  try {
    const url = new URL(value);
    const params = url.searchParams;
    if (params.size !== LOCAL_PROXY_QUERY_KEYS.size
      || [...params.keys()].some((key) => !LOCAL_PROXY_QUERY_KEYS.has(key) || params.getAll(key).length !== 1)
      || params.get('server') !== '127.0.0.1' || !/^[a-f\d]{32}$/i.test(params.get('secret') || '')
      || !/^\d{4,5}$/.test(params.get('port') || '')) return undefined;
    const port = Number(params.get('port'));
    if (port < MIN_LOCAL_PROXY_PORT || port > MAX_LOCAL_PROXY_PORT) return undefined;
    return { url: value, port };
  } catch {
    return undefined;
  }
}
