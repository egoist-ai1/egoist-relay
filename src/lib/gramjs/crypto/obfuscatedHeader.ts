import { bufferFromHex, buffersEqual, concat } from '../../../util/encoding/buffer';

import { CTR } from './CTR';

const HEADER_LENGTH = 64;
const ZERO_INT = new Uint8Array(4);
const FORBIDDEN_PREFIXES = [
  '48454144', '504f5354', '47455420', '4f505449', '16030102', 'dddddddd', 'eeeeeeee',
].map((prefix) => bufferFromHex(prefix));

export function createObfuscatedHeader(tag: Uint8Array) {
  const random = new Uint8Array(HEADER_LENGTH);
  do {
    crypto.getRandomValues(random);
  } while (
    random[0] === 0xef
    || FORBIDDEN_PREFIXES.some((prefix) => buffersEqual(prefix, random.subarray(0, 4)))
    || buffersEqual(random.subarray(4, 8), ZERO_INT)
  );
  const reversed = random.slice(8, 56).reverse();
  const encryptor = new CTR(random.slice(8, 40), random.slice(40, 56));
  const decryptor = new CTR(reversed.slice(0, 32), reversed.slice(32, 48));
  random.set(tag, 56);
  const header = concat(random.subarray(0, 56), encryptor.encrypt(random).subarray(56));
  return { header, encryptor, decryptor };
}
