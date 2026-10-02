import type { Logger } from '../../extensions';
import type { AbridgedPacketCodec } from './TCPAbridged';

import { AsyncQueue, PromisedWebSockets } from '../../extensions';

import HttpStream from '../../extensions/HttpStream';

interface ConnectionInterfaceParams {
  ip: string;
  port: number;
  dcId: number;
  loggers: Logger;
  isPremium?: boolean;
  isTestServer?: boolean;
}

export interface PacketReader {
  read(length: number): Promise<Uint8Array>;
  readExactly(length: number): Promise<Uint8Array>;
}

/**
 * The `Connection` class is a wrapper around ``asyncio.open_connection``.
 *
 * Subclasses will implement different transport modes as atomic operations,
 * which this class eases doing since the exposed interface simply puts and
 * gets complete data payloads to and from queues.
 *
 * The only error that will raise from send and receive methods is
 * ``ConnectionError``, which will raise when attempting to send if
 * the client is disconnected (includes remote disconnections).
 */
export class Connection {
  PacketCodecClass?: typeof AbridgedPacketCodec;

  readonly _ip: string;

  readonly _port: number;

  _dcId: number;

  _log: Logger;

  _connected: boolean;

  _isPremium?: boolean;

  shouldLongPoll: boolean;

  private _sendTask?: Promise<void>;

  private _recvTask?: Promise<void>;

  private _connectionId = 0;

  private _connectTask?: Promise<void>;

  protected _codec: any;

  protected _obfuscation: any;

  _sendArray: AsyncQueue<Uint8Array | undefined>;

  _recvArray: AsyncQueue<Uint8Array | undefined>;

  socket: PromisedWebSockets | HttpStream;

  public _isTestServer?: boolean;

  constructor({
    ip, port, dcId, loggers, isPremium, isTestServer,
  }: ConnectionInterfaceParams) {
    this._ip = ip;
    this._port = port;
    this._dcId = dcId;
    this._log = loggers;
    this._isTestServer = isTestServer;

    this._isPremium = isPremium;
    this._connected = false;
    this._sendTask = undefined;
    this._recvTask = undefined;
    this._codec = undefined;
    this._obfuscation = undefined; // TcpObfuscated and MTProxy
    this._sendArray = new AsyncQueue<Uint8Array | undefined>();
    this._recvArray = new AsyncQueue<Uint8Array | undefined>();
    // this.socket = new PromiseSocket(new Socket())

    this.shouldLongPoll = false;
    this.socket = new PromisedWebSockets(this.disconnectCallback.bind(this));
  }

  isConnected() {
    return this._connected;
  }

  disconnectCallback() {
    this.disconnect(true);
  }

  async _connect() {
    this._log.debug('Connecting');
    this._codec = new this.PacketCodecClass!(this);
    await this.socket.connect(this._port, this._ip, this._isTestServer, this._isPremium, this._dcId);
    this._log.debug('Finished connecting');

    await this._initConn();
  }

  async connect() {
    if (this._connected) return;
    if (this._connectTask) return this._connectTask;
    const connectTask = this._connectOnce();
    this._connectTask = connectTask;
    try {
      await connectTask;
    } finally {
      this._connectTask = undefined;
    }
  }

  private async _connectOnce() {
    const connectionId = ++this._connectionId;
    this._sendArray = new AsyncQueue<Uint8Array | undefined>();
    this._recvArray = new AsyncQueue<Uint8Array | undefined>();
    try {
      await this._connect();
    } catch (err) {
      this.socket.close();
      throw err;
    }
    if (connectionId !== this._connectionId) {
      this.socket.close();
      throw new Error('Not connected');
    }
    this._connected = true;

    this._sendTask = this._sendLoop(connectionId);
    this._recvTask = this._recvLoop(connectionId);
  }

  disconnect(fromCallback = false) {
    if (!this._connected && !this._connectTask) {
      return;
    }

    this._connected = false;
    this._connectionId += 1;
    void this._sendArray.push(undefined);
    void this._recvArray.push(undefined);
    if (!fromCallback) {
      this.socket.close();
    }
  }

  async send(data: Uint8Array) {
    const connectionId = this._connectionId;
    if (!this._connected) {
      throw new Error('Not connected');
    }
    await this._sendArray.push(data);
    if (!this._connected || connectionId !== this._connectionId) throw new Error('Not connected');
  }

  async recv() {
    const connectionId = this._connectionId;
    const recvArray = this._recvArray;
    while (this._connected && connectionId === this._connectionId) {
      const result = await recvArray.pop();
      if (!this._connected || connectionId !== this._connectionId) break;
      // null = sentinel value = keep trying
      if (result) {
        return result;
      }
    }
    throw new Error('Not connected');
  }

  async _sendLoop(connectionId = this._connectionId) {
    const sendArray = this._sendArray;
    try {
      while (this._connected && connectionId === this._connectionId) {
        const data = await sendArray.pop();
        if (!data || !this._connected || connectionId !== this._connectionId) return;
        await this._send(data);
      }
    } catch (e) {
      this._log.info('The server closed the connection while sending');
      if (connectionId === this._connectionId) this.disconnect();
    }
  }

  async _recvLoop(connectionId = this._connectionId) {
    const recvArray = this._recvArray;
    let data;
    while (this._connected && connectionId === this._connectionId) {
      try {
        data = await this._recv();
        if (!data) {
          throw new Error('no data received');
        }
      } catch (e) {
        this._log.info('connection closed');
        if (connectionId === this._connectionId) this.disconnect();
        return;
      }
      if (!this._connected || connectionId !== this._connectionId) return;
      await recvArray.push(data);
    }
  }

  async _initConn() {
    if (this._codec.tag) {
      await this.socket.write(this._codec.tag);
    }
  }

  _send(data: Uint8Array) {
    const encodedPacket = this._codec.encodePacket(data);
    return this.socket.write(encodedPacket);
  }

  _recv() {
    return this._codec.readPacket(this.socket);
  }

  toString() {
    return `${this._ip}:${this._port}/${this.constructor.name.replace('Connection', '')}`;
  }
}

export class ObfuscatedConnection extends Connection {
  ObfuscatedIO: any = undefined;

  async _initConn() {
    this._obfuscation = new this.ObfuscatedIO(this);
    await this.socket.write(this._obfuscation.header);
  }

  _send(data: Uint8Array) {
    return this._obfuscation.write(this._codec.encodePacket(data));
  }

  _recv() {
    return this._codec.readPacket(this._obfuscation);
  }
}

export class PacketCodec {
  private _conn: Connection;

  constructor(connection: Connection) {
    this._conn = connection;
  }

  encodePacket(data: Uint8Array) {
    throw new Error('Not Implemented');

    // Override
  }

  readPacket(reader: PacketReader) {
    // override
    throw new Error('Not Implemented');
  }
}

export class HttpConnection extends Connection {
  socket: HttpStream;

  href: string;

  constructor(params: ConnectionInterfaceParams) {
    super(params);
    this.shouldLongPoll = true;
    this.socket = new HttpStream(this.disconnectCallback.bind(this));
    this.href = HttpStream.getURL(this._ip, this._port, this._isTestServer, this._isPremium);
  }

  send(data: Uint8Array) {
    return this.socket.write(data);
  }

  recv() {
    return this.socket.read();
  }

  async _connect() {
    this._log.debug('Connecting');
    await this.socket.connect(this._port, this._ip, this._isTestServer, this._isPremium);
    this._log.debug('Finished connecting');
  }

  async connect() {
    await this._connect();
    this._connected = true;
  }
}
