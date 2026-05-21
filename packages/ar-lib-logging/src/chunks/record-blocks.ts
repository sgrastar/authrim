import type { LogChunkCompression } from '../registry';
import type { LogChunkRecord } from './types';

export interface LogRecordBlockIndexEntry {
  blockIndex: number;
  compressedOffset: number;
  compressedLength: number;
  uncompressedLength: number;
  firstLineNumber: number;
  lastLineNumber: number;
  recordCount: number;
}

export interface LogRecordLocationIndexEntry {
  recordId: string;
  lineNumber: number;
  blockIndex: number;
  recordOffset: number;
  recordLength: number;
}

export interface EncodedLogRecordBlocks {
  body: Uint8Array;
  blocks: LogRecordBlockIndexEntry[];
  records: LogRecordLocationIndexEntry[];
  compression: LogChunkCompression;
}

export interface EncodeLogRecordBlocksOptions {
  compression?: LogChunkCompression;
  maxUncompressedBlockBytes?: number;
}

const DEFAULT_MAX_UNCOMPRESSED_BLOCK_BYTES = 256 * 1024;

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function compressBlock(
  bytes: Uint8Array,
  compression: LogChunkCompression
): Promise<Uint8Array> {
  if (compression !== 'gzip_block' || typeof CompressionStream === 'undefined') {
    return bytes;
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressBlock(
  bytes: Uint8Array,
  compression: LogChunkCompression
): Promise<Uint8Array> {
  if (compression !== 'gzip_block' || typeof DecompressionStream === 'undefined') {
    return bytes;
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function encodeLogRecordBlocks(
  records: LogChunkRecord[],
  options: EncodeLogRecordBlocksOptions = {}
): Promise<EncodedLogRecordBlocks> {
  const compression = options.compression ?? 'gzip_block';
  const maxUncompressedBlockBytes =
    options.maxUncompressedBlockBytes ?? DEFAULT_MAX_UNCOMPRESSED_BLOCK_BYTES;
  const encoder = new TextEncoder();
  const encodedRecords = records.map((record, index) => {
    const line = JSON.stringify(record.payload);
    const isLast = index === records.length - 1;
    return {
      record,
      lineBytes: encoder.encode(line),
      storedBytes: encoder.encode(isLast ? line : `${line}\n`),
    };
  });

  const bodyParts: Uint8Array[] = [];
  const blockEntries: LogRecordBlockIndexEntry[] = [];
  const recordEntries: LogRecordLocationIndexEntry[] = [];
  let currentParts: Uint8Array[] = [];
  let currentRecords: Array<{
    recordId: string;
    lineNumber: number;
    recordOffset: number;
    recordLength: number;
  }> = [];
  let currentUncompressedLength = 0;
  let compressedOffset = 0;

  const flushBlock = async (): Promise<void> => {
    if (currentParts.length === 0 || currentRecords.length === 0) {
      return;
    }

    const blockIndex = blockEntries.length;
    const uncompressed = concatBytes(currentParts);
    const compressed = await compressBlock(uncompressed, compression);
    bodyParts.push(compressed);
    blockEntries.push({
      blockIndex,
      compressedOffset,
      compressedLength: compressed.byteLength,
      uncompressedLength: uncompressed.byteLength,
      firstLineNumber: currentRecords[0].lineNumber,
      lastLineNumber: currentRecords[currentRecords.length - 1].lineNumber,
      recordCount: currentRecords.length,
    });
    for (const record of currentRecords) {
      recordEntries.push({
        ...record,
        blockIndex,
      });
    }
    compressedOffset += compressed.byteLength;
    currentParts = [];
    currentRecords = [];
    currentUncompressedLength = 0;
  };

  for (const [lineNumber, encoded] of encodedRecords.entries()) {
    if (
      currentParts.length > 0 &&
      currentUncompressedLength + encoded.storedBytes.byteLength > maxUncompressedBlockBytes
    ) {
      await flushBlock();
    }

    currentRecords.push({
      recordId: encoded.record.id,
      lineNumber,
      recordOffset: currentUncompressedLength,
      recordLength: encoded.lineBytes.byteLength,
    });
    currentParts.push(encoded.storedBytes);
    currentUncompressedLength += encoded.storedBytes.byteLength;
  }

  await flushBlock();

  return {
    body: concatBytes(bodyParts),
    blocks: blockEntries,
    records: recordEntries,
    compression,
  };
}

export async function decodeLogRecordFromBlock(
  body: Uint8Array,
  block: LogRecordBlockIndexEntry,
  record: LogRecordLocationIndexEntry,
  compression: LogChunkCompression
): Promise<unknown> {
  if (record.blockIndex !== block.blockIndex) {
    throw new Error('log_record_block_mismatch');
  }

  const compressedBlock = body.slice(
    block.compressedOffset,
    block.compressedOffset + block.compressedLength
  );
  const uncompressedBlock = await decompressBlock(compressedBlock, compression);
  const recordBytes = uncompressedBlock.slice(
    record.recordOffset,
    record.recordOffset + record.recordLength
  );
  return JSON.parse(new TextDecoder().decode(recordBytes));
}
