import { alignedCeil } from '../../util/align.js';
import { mcuType } from '../core.js';
import type { MCUContext } from '../types.js';

function* readChunk(ctx: MCUContext, addr: number, chunkSize: number, maxLength: number) {
    const startChunkAddr = alignedCeil(addr, chunkSize);
    const endAddr = addr + maxLength;
    if (startChunkAddr !== addr) {
        const unalignedFirstChunk = Buffer.alloc(startChunkAddr - addr);
        ctx.link.memory.read(addr, unalignedFirstChunk);
        yield unalignedFirstChunk;
    }
    for (let p = startChunkAddr; p < endAddr; p += chunkSize) {
        const chunkBuffer = Buffer.alloc(Math.min(chunkSize, endAddr - p));
        ctx.link.memory.read(addr, chunkBuffer);
        yield chunkBuffer;
    }
}

/**
 * Construct a string buffer type.
 * @param maxLength Maximum string length, excluding the null terminator.
 * @param encoding String encoding. Defaults to 'latin1' for single-byte character support. Use 'utf16le' for wide characters.
 * @param chunkSize Chunk size for hardware reads. Must be a multiple of the character width. Defaults to 256 bytes.
 */
export function makeStringBuffer(maxLength: number, encoding: BufferEncoding = 'latin1', chunkSize: number = 256) {
    const width = Buffer.from('\0', encoding).length;
    if (width === 0) {
        throw new Error(`Encoding ${encoding} does not support null-terminated strings.`);
    }
    if (chunkSize % width !== 0) {
        throw new Error(`Chunk size ${chunkSize} is not a multiple of character width ${width}.`);
    }
    const size = maxLength * width;
    return mcuType(width === 2 ? `_string_ wchar[${maxLength}]` : `_string_ char[${size}]`, size, {
        align: width,
        fromMemory(ctx, addr, buffer) {
            let stringBuffer: Buffer;
            if (buffer !== undefined) {
                const end = buffer.indexOf('\0', 0, encoding);
                if (end >= 0) {
                    stringBuffer = buffer.subarray(0, end);
                } else {
                    stringBuffer = buffer;
                }
            } else {
                const chunks: Buffer[] = [];
                for (const chunk of readChunk(ctx, addr, chunkSize, maxLength)) {
                    const end = chunk.indexOf('\0', 0, encoding);
                    if (end >= 0) {
                        chunks.push(chunk.subarray(0, end));
                        break;
                    } else {
                        chunks.push(chunk);
                    }
                }
                stringBuffer = Buffer.concat(chunks);
            }
            return stringBuffer.toString(encoding);
        },
        toMemory(ctx, addr, value, buffer) {
            const stringBuffer = Buffer.from(value, encoding);
            if (stringBuffer.length > maxLength) {
                throw new Error(`String is too long (${stringBuffer.length} > ${maxLength})`);
            }
            if (buffer !== undefined) {
                buffer.set(stringBuffer);
            } else {
                ctx.link.memory.write(addr, stringBuffer);
            }
        },
    });
}
