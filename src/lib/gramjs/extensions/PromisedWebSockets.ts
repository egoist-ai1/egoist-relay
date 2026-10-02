const closeError = new Error('WebSocket was closed');
const CONNECTION_TIMEOUT = 3000;
const MAX_TIMEOUT = 30000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_INCOMING_BYTES = 64 * 1024 * 1024;
const WRITE_POLL_INTERVAL = 25;
let desktopTransportUrl: string | undefined;

export function setDesktopTelegramTransport(value?: string) {
  desktopTransportUrl = undefined;
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port
      && url.pathname === '/apiws' && !url.username && !url.password && !url.hash
      && /^[a-f0-9]{64}$/.test(url.searchParams.get('token') || '')
      && [...url.searchParams].length === 1) {
      desktopTransportUrl = value;
    }
  } catch (err) { /* Invalid native transport URLs use the official route */ }
}

export default class PromisedWebSockets {
  private closed: boolean;

  private timeout: number;

  private chunks: Uint8Array[] = [];

  private chunkOffset = 0;

  private totalBytes = 0;

  private canRead?: boolean | Promise<boolean>;

  private resolveRead: ((value?: any) => void) | undefined;

  private client: WebSocket | undefined;

  private website?: string;

  private disconnectedCallback: () => void;

  private rejectConnect?: (error: Error) => void;

  private handleOffline = () => {
    this.close();
  };

  constructor(disconnectedCallback: () => void) {
    this.client = undefined;
    this.closed = true;
    this.chunks = [];
    this.chunkOffset = 0;
    this.totalBytes = 0;
    this.disconnectedCallback = disconnectedCallback;
    this.timeout = CONNECTION_TIMEOUT;
  }

  async readExactly(number: number): Promise<Uint8Array> {
    const client = this.client;
    if (this.closed) {
      throw closeError;
    }
    if (number === 0) {
      return new Uint8Array(0);
    }

    // Fast path: if available in the first chunk, return a zero-copy subarray
    while (this.totalBytes < number) {
      if (this.closed || this.client !== client) {
        throw closeError;
      }
      await this.waitForData();
    }

    if (this.closed || this.client !== client) throw closeError;

    const firstChunk = this.chunks[0];
    const availableInFirst = firstChunk.length - this.chunkOffset;

    if (availableInFirst >= number) {
      const slice = firstChunk.subarray(this.chunkOffset, this.chunkOffset + number);
      this.chunkOffset += number;
      this.totalBytes -= number;
      if (this.chunkOffset === firstChunk.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
      if (this.totalBytes === 0) {
        this.canRead = new Promise((resolve) => {
          this.resolveRead = resolve;
        });
      }
      return slice;
    }

    // Spans across multiple chunks: allocate once and fill
    const result = new Uint8Array(number);
    let bytesRead = 0;

    while (bytesRead < number) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.chunkOffset;
      const needed = number - bytesRead;
      const toCopy = Math.min(available, needed);

      result.set(chunk.subarray(this.chunkOffset, this.chunkOffset + toCopy), bytesRead);
      bytesRead += toCopy;
      this.chunkOffset += toCopy;
      this.totalBytes -= toCopy;

      if (this.chunkOffset === chunk.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }

    if (this.totalBytes === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return result;
  }

  async read(number: number): Promise<Uint8Array> {
    const client = this.client;
    if (this.closed) {
      throw closeError;
    }
    if (number === 0) return new Uint8Array(0);
    while (this.totalBytes === 0) {
      if (this.closed || this.client !== client) {
        throw closeError;
      }
      await this.waitForData();
    }

    if (this.closed || this.client !== client) throw closeError;

    const firstChunk = this.chunks[0];
    const available = firstChunk.length - this.chunkOffset;

    if (available <= number) {
      const slice = this.chunkOffset === 0 ? firstChunk : firstChunk.subarray(this.chunkOffset);
      this.chunks.shift();
      this.chunkOffset = 0;
      this.totalBytes -= available;
      if (this.totalBytes === 0) {
        this.canRead = new Promise((resolve) => {
          this.resolveRead = resolve;
        });
      }
      return slice;
    }

    const slice = firstChunk.subarray(this.chunkOffset, this.chunkOffset + number);
    this.chunkOffset += number;
    this.totalBytes -= number;
    return slice;
  }

  async readAll(): Promise<Uint8Array> {
    const client = this.client;
    if (this.closed) {
      throw closeError;
    }
    while (this.totalBytes === 0) {
      if (this.closed || this.client !== client) {
        throw closeError;
      }
      await this.waitForData();
    }

    if (this.closed || this.client !== client) throw closeError;

    if (this.chunks.length === 1 && this.chunkOffset === 0) {
      const single = this.chunks[0];
      this.chunks = [];
      this.totalBytes = 0;
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
      return single;
    }

    const result = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const start = (i === 0 ? this.chunkOffset : 0);
      const slice = chunk.subarray(start);
      result.set(slice, offset);
      offset += slice.length;
    }

    this.chunks = [];
    this.chunkOffset = 0;
    this.totalBytes = 0;
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    return result;
  }

  getWebSocketLink(ip: string, port: number, isTestServer?: boolean, isPremium?: boolean, dcId?: number) {
    if (desktopTransportUrl && !isTestServer) {
      const url = new URL(desktopTransportUrl);
      const match = ip.match(/zws(\d+)(-1)?/i);
      url.searchParams.set('dc', String(dcId || Number(match?.[1]) || 2));
      if (match?.[2]) url.searchParams.set('media', '1');
      if (isPremium) url.searchParams.set('premium', '1');
      return url.toString();
    }
    const { location } = globalThis;
    const isTauri = location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';
    const customProxy = isTauri ? undefined
      : (typeof window !== 'undefined' && window.localStorage?.getItem('egoist_relay_proxy'))
        || (typeof import.meta !== 'undefined' && (import.meta.env.VITE_PROXY_URL || import.meta.env.TG_PROXY_URL));
    if (customProxy) {
      const match = ip.match(/zws(\d+)(-1)?/i);
      const dc = dcId ? String(dcId) : (match ? match[1] : '2');
      const testParam = isTestServer ? '&test=1' : '';
      const premiumParam = isPremium ? '&premium=1' : '';
      const mediaParam = match?.[2] ? '&media=1' : '';
      return `${customProxy.replace(/\/$/, '')}/apiws?dc=${dc}${testParam}${premiumParam}${mediaParam}`;
    }
    if (port === 443) {
      return `wss://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    } else {
      return `ws://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    }
  }

  connect(port: number, ip: string, isTestServer = false, isPremium = false, dcId?: number) {
    this.close();
    this.chunks = [];
    this.chunkOffset = 0;
    this.totalBytes = 0;
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;
    this.website = this.getWebSocketLink(ip, port, isTestServer, isPremium, dcId);
    const client = new WebSocket(this.website, 'binary');
    this.client = client;
    client.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      let hasResolved = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

      this.rejectConnect = (error) => {
        if (hasResolved) return;
        hasResolved = true;
        reject(error);
        if (timeout) clearTimeout(timeout);
        this.rejectConnect = undefined;
      };

      client.onopen = () => {
        if (this.client !== client || this.closed || hasResolved) return;
        this.receive();
        hasResolved = true;
        this.rejectConnect = undefined;
        this.timeout = CONNECTION_TIMEOUT;
        resolve(this);
        if (timeout) clearTimeout(timeout);
      };

      client.onerror = (error) => {
        if (this.client !== client) return;
        // eslint-disable-next-line no-console
        console.error('WebSocket error', error);
        this.close();
      };

      client.onclose = (event) => {
        if (this.client !== client) return;
        const { code, reason, wasClean } = event;
        if (code !== 1000) {
          // eslint-disable-next-line no-console
          console.error(`Socket ${ip} closed. Code: ${code}, reason: ${reason}, was clean: ${wasClean}`);
        }

        this.close();
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        if (timeout) clearTimeout(timeout);
      };

      timeout = setTimeout(() => {
        if (hasResolved) return;

        this.rejectConnect?.(new Error('WebSocket connection timeout'));
        this.close();
        this.timeout *= 2;
        this.timeout = Math.min(this.timeout, MAX_TIMEOUT);
        timeout = undefined;
      }, this.timeout);

      self.removeEventListener('offline', this.handleOffline);
      self.addEventListener('offline', this.handleOffline);
    });
  }

  async write(data: Uint8Array) {
    const client = this.client;
    if (this.closed || !client || client.readyState !== WebSocket.OPEN) {
      throw closeError;
    }
    const startedAt = Date.now();
    while (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, WRITE_POLL_INTERVAL));
      if (this.closed || this.client !== client || client.readyState !== WebSocket.OPEN) throw closeError;
      if (Date.now() - startedAt > MAX_TIMEOUT) {
        this.close();
        throw new Error('WebSocket write timeout');
      }
    }
    client.send(new Uint8Array(data));
  }

  close() {
    self.removeEventListener('offline', this.handleOffline);
    this.rejectConnect?.(closeError);
    this.closed = true;
    this.resolveRead?.(false);
    this.resolveRead = undefined;
    this.chunks = [];
    this.chunkOffset = 0;
    this.totalBytes = 0;
    if (this.client && this.client.readyState < WebSocket.CLOSING) this.client.close();
  }

  receive() {
    if (!this.client) return;
    const client = this.client;
    client.onmessage = (message) => {
      if (this.closed || this.client !== client) return;
      const data = new Uint8Array(message.data);
      if (data.length === 0) return;
      if (this.totalBytes + data.length > MAX_INCOMING_BYTES) {
        this.close();
        return;
      }
      this.chunks.push(data);
      this.totalBytes += data.length;
      if (this.resolveRead) {
        const resolve = this.resolveRead;
        this.resolveRead = undefined;
        resolve(true);
      }
    };
  }

  private waitForData() {
    if (!this.resolveRead) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }
    return this.canRead;
  }
}
