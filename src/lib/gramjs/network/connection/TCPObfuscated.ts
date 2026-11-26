import type { CTR } from '../../crypto/CTR';
import type { HttpStream, PromisedWebSockets } from '../../extensions';
import type { PacketReader } from './Connection';

import { createObfuscatedHeader } from '../../crypto/obfuscatedHeader';

import { ObfuscatedConnection } from './Connection';
import { AbridgedPacketCodec } from './TCPAbridged';

class ObfuscatedIO implements PacketReader {
  header?: Uint8Array = undefined;

  private connection: PromisedWebSockets | HttpStream;

  private _encrypt: CTR;

  private _decrypt: CTR;

  constructor(connection: ConnectionTCPObfuscated) {
    this.connection = connection.socket;
    const { header, encryptor, decryptor } = createObfuscatedHeader(connection.PacketCodecClass.obfuscateTag);
    this.header = header;
    this._encrypt = encryptor;
    this._decrypt = decryptor;
  }

  async read(n: number) {
    const data = await this.connection.readExactly(n);
    return this._decrypt.encrypt(data);
  }

  readExactly(n: number) {
    return this.read(n);
  }

  write(data: Uint8Array) {
    return this.connection.write(this._encrypt.encrypt(data));
  }
}

export class ConnectionTCPObfuscated extends ObfuscatedConnection {
  ObfuscatedIO = ObfuscatedIO;

  PacketCodecClass = AbridgedPacketCodec;
}
