import { createLazilyAccessor, MemoryAddress, mcuType, NativeType } from '../core.js';
import { createReference, type MCUReference } from '../reference.js';
import { createSymbol, type MCUSymbol } from '../symbol.js';
import type { MCUContext, MCUFunctionDef, MCUTypeDef, ToAsyncFunction, ToJsType } from '../types.js';

/**
 * A typed view over a region of MCU memory with bounds checking.
 */
export class MCUSpan {
    #type: MCUTypeDef<MCUSpan> | undefined;
    #symbol: MCUSymbol<MCUTypeDef<MCUSpan>> | undefined;
    readonly context: MCUContext;
    readonly address: number;
    readonly size?: number;

    constructor(ctx: MCUContext, addr: number, size?: number, type?: MCUTypeDef<MCUSpan>) {
        this.context = ctx;
        this.#type = type;
        this.address = addr;
        this.size = size;
    }

    get [NativeType]() {
        if (!this.#type) {
            this.#type = makeSpan(this.size);
        }
        return this.#type;
    }

    get [MemoryAddress]() {
        return this.address;
    }

    get symbol() {
        if (!this.#symbol) {
            this.#symbol = createSymbol(this.context, this.address, this[NativeType]);
        }
        return this.#symbol;
    }

    protected checkValidIndex(value: number, allowEqual?: boolean) {
        if (value < 0 || Number.isNaN(value) || !Number.isSafeInteger(value)) {
            return false;
        }
        if (this.size !== undefined) {
            if (allowEqual) {
                if (value > this.size) {
                    return false;
                }
            } else {
                if (value >= this.size) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Get a sub-region of the memory region.
     * @param start Start position.
     * @param end End position. Defaults to the end of the region.
     */
    slice(start: number, end?: number) {
        if (!this.checkValidIndex(start, true)) {
            throw new Error('Invalid start index');
        }
        if (end !== undefined) {
            if (!this.checkValidIndex(end, true)) {
                throw new Error('Invalid end index');
            }
            if (end < start) {
                throw new Error('Invalid range');
            }
        }
        return new MCUSpan(this.context, this.address + start, end ? end - start : this.size);
    }

    /**
     * Cast the memory region to a dynamic view of the specified type.
     * @param type Target type.
     * @param offset Offset.
     */
    cast<T>(type: MCUTypeDef<T>, offset: number = 0): T {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return type.lazilyAccess(this.context, this.address + offset);
    }

    /**
     * Cast the memory region to a function of the specified type.
     * @param def Function definition.
     * @param offset Offset.
     */
    bind<F extends (...args: never[]) => unknown>(def: MCUFunctionDef<F>, offset: number = 0): ToAsyncFunction<F> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        return def(this.context, this.address + offset, '(anonymous)');
    }

    /**
     * Read and deserialize data from the memory region.
     * @param type Data type.
     * @param offset Offset.
     */
    read<T extends MCUTypeDef>(type: T, offset: number = 0): ToJsType<T> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return type.fromMemory(this.context, this.address + offset);
    }

    /**
     * Serialize and write data to the memory region.
     * @param type Data type.
     * @param value Data value.
     * @param offset Offset.
     */
    write<T extends MCUTypeDef>(type: T, value: ToJsType<T>, offset: number = 0) {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        type.toMemory(this.context, this.address + offset, value);
    }

    /**
     * Create a data reference within the memory region.
     * @param type Data type.
     * @param offset Offset.
     */
    referenceOf<T extends MCUTypeDef>(type: T, offset: number = 0): MCUReference<T> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return createReference(this.context, this.address + offset, type);
    }

    /**
     * Copy data from the memory region to a target memory region.
     * @param target Target memory region.
     * @param targetStart Start position in target. Defaults to 0.
     * @param sourceStart Start position in source. Defaults to 0.
     * @param sourceEnd End position in source. Defaults to the end of the region.
     */
    copyTo(target: MCUSpan, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
        if (targetStart !== undefined && !target.checkValidIndex(targetStart, true)) {
            throw new Error('Invalid target start index');
        }
        if (sourceStart !== undefined && !this.checkValidIndex(sourceStart, true)) {
            throw new Error('Invalid source start index');
        }
        if (sourceEnd !== undefined && !this.checkValidIndex(sourceEnd, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const sourceSize = this.size !== undefined ? this.size - srcStart : Infinity;
        const targetSize = target.size !== undefined ? target.size - tgtStart : Infinity;
        const sizeLimit = Math.min(sourceSize, targetSize);
        let size = sizeLimit;
        if (sourceEnd !== undefined) {
            size = sourceEnd - srcStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (!Number.isFinite(size)) {
            throw new Error(
                'Size is required for copying between spans of unknown length. Please specify the size explicitly.',
            );
        }
        if (size <= 0) return;
        const buffer = Buffer.allocUnsafe(size);
        this.context.link.memory.read(this.address + srcStart, buffer);
        target.context.link.memory.write(target.address + tgtStart, buffer);
    }

    /**
     * Read data from the memory region and returns it as a new Buffer.
     * @param start Start position. Defaults to 0.
     * @param end End position. Defaults to the end of the region.
     * @returns A buffer containing the copied data.
     */
    readBuffer(start?: number, end?: number) {
        if (start !== undefined && !this.checkValidIndex(start)) {
            throw new Error('Invalid source start index');
        }
        if (end !== undefined && !this.checkValidIndex(end, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = start ?? 0;
        const size = end !== undefined ? end - srcStart : this.size !== undefined ? this.size - srcStart : Infinity;
        if (!Number.isFinite(size)) {
            throw new Error(
                'Size is required for reading spans of unknown length. Please specify the size explicitly.',
            );
        }
        const buffer = Buffer.allocUnsafe(size);
        this.context.link.memory.read(this.address + srcStart, buffer);
        return buffer;
    }

    /**
     * Copy data from the memory region to a given target buffer.
     * @param target Target buffer.
     * @param targetStart Start position in target buffer. Defaults to 0.
     * @param sourceStart Start position in source memory. Defaults to 0.
     * @param sourceEnd End position in source memory. Defaults to the end of the region.
     */
    readIntoBuffer(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
        if (targetStart !== undefined && targetStart > target.length) {
            throw new Error('Invalid target start index');
        }
        if (sourceStart !== undefined && !this.checkValidIndex(sourceStart)) {
            throw new Error('Invalid source start index');
        }
        if (sourceEnd !== undefined && !this.checkValidIndex(sourceEnd, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const sourceSize = this.size !== undefined ? this.size - srcStart : Infinity;
        const targetSize = target.length - tgtStart;
        const sizeLimit = Math.min(sourceSize, targetSize);
        let size = sizeLimit;
        if (sourceEnd !== undefined) {
            size = sourceEnd - srcStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (size <= 0) return;
        this.context.link.memory.read(this.address + srcStart, target.subarray(tgtStart, tgtStart + size));
        return target;
    }

    /**
     * Write data from a source buffer to the memory region.
     * @param source Source buffer.
     * @param sourceStart Start position in source buffer. Defaults to 0.
     * @param targetStart Start position in target memory. Defaults to 0.
     * @param targetEnd End position in target memory. Defaults to the end of the region.
     */
    writeBuffer(source: Buffer, sourceStart?: number, targetStart?: number, targetEnd?: number) {
        if (sourceStart !== undefined && sourceStart > source.length) {
            throw new Error('Invalid source start index');
        }
        if (targetStart !== undefined && !this.checkValidIndex(targetStart, true)) {
            throw new Error('Invalid target start index');
        }
        if (targetEnd !== undefined && !this.checkValidIndex(targetEnd, true)) {
            throw new Error('Invalid target end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const targetSize = this.size !== undefined ? this.size - tgtStart : Infinity;
        const sourceSize = source.length - srcStart;
        const sizeLimit = Math.min(targetSize, sourceSize);
        let size = sizeLimit;
        if (targetEnd !== undefined) {
            size = targetEnd - tgtStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (size <= 0) return;
        this.context.link.memory.write(this.address + tgtStart, source.subarray(srcStart, srcStart + size));
    }
}

let infiniteSpanType: MCUTypeDef<MCUSpan> | undefined;

/**
 * Construct a memory region type.
 * @param size Region size. Omit for infinite size.
 */
export function makeSpan(size?: number): MCUTypeDef<MCUSpan> {
    if (size !== undefined) {
        const type = mcuType(`Span[${size}]`, size, {
            fromMemory: (ctx, addr): MCUSpan => {
                return new MCUSpan(ctx, addr, size, type);
            },
            toMemory: () => {
                throw new Error(`Invalid operation, use MCUSpan.copyTo instead.`);
            },
            lazilyAccess: createLazilyAccessor(),
        });
        return type;
    } else {
        if (!infiniteSpanType) {
            infiniteSpanType = mcuType('Span[*]', 0, {
                fromMemory: (ctx, addr) => {
                    return new MCUSpan(ctx, addr, undefined, infiniteSpanType);
                },
                toMemory: () => {
                    throw new Error(`Invalid operation, use MCUSpan.copyTo instead.`);
                },
                lazilyAccess: createLazilyAccessor(),
            });
        }
        return infiniteSpanType;
    }
}
