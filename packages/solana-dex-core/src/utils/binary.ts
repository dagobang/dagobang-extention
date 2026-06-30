import { PublicKey } from '@solana/web3.js';

export class BinaryReader {
  private readonly view: DataView;

  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  getOffset(): number {
    return this.offset;
  }

  setOffset(nextOffset: number): void {
    if (nextOffset < 0 || nextOffset > this.buffer.length) {
      throw new Error(`Invalid binary reader offset: ${nextOffset}`);
    }
    this.offset = nextOffset;
  }

  remaining(): number {
    return this.buffer.length - this.offset;
  }

  skip(length: number): void {
    this.checkBounds(length);
    this.offset += length;
  }

  readBytes(length: number): Uint8Array {
    this.checkBounds(length);
    const out = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readBool(): boolean {
    return this.readU8() === 1;
  }

  readU8(): number {
    this.checkBounds(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readU16(): number {
    this.checkBounds(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readU32(): number {
    this.checkBounds(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readI32(): number {
    this.checkBounds(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readU64(): bigint {
    this.checkBounds(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readI64(): bigint {
    this.checkBounds(8);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readU128(): bigint {
    return this.readBigInt(16);
  }

  readI128(): bigint {
    return this.readBigInt(16, true);
  }

  readPublicKey(): PublicKey {
    return new PublicKey(this.readBytes(32));
  }

  private readBigInt(size: number, signed = false): bigint {
    this.checkBounds(size);
    let value = 0n;
    for (let i = 0; i < size; i += 1) {
      value |= BigInt(this.buffer[this.offset + i] ?? 0) << (8n * BigInt(i));
    }
    this.offset += size;
    if (!signed) return value;
    const bitSize = 8n * BigInt(size);
    const signBit = 1n << (bitSize - 1n);
    return (value & signBit) === 0n ? value : value - (1n << bitSize);
  }

  private checkBounds(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new Error(`Binary reader overflow: offset=${this.offset} length=${length} size=${this.buffer.length}`);
    }
  }
}

export function parseSplTokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error('Invalid SPL token account');
  return new BinaryReader(data.slice(64, 72)).readU64();
}
