/**
 * @module mculink/armv6-m
 */
import { alignedCeil, alignedFloor } from './binparse.js';
import {
    addressToString,
    makeArray,
    makeBuffer,
    makeCallConvention,
    makeCompositeCall,
    makeEnum,
    makeFlags,
    makeFunctionType,
    makePeripheral,
    makePointerType,
    makeReferenceType,
    makeSpan,
    makeStructure,
    makeTypedArray,
    makeUnion,
    mcuType,
    narrowType,
    neverType,
    voidType,
} from './mcucall.js';

declare module './mcucall.js' {
    interface MCUTypeDef {
        /**
         * Whether this is a floating-point type.
         */
        float?: boolean;
    }
}

export class MCUTypes {
    void = voidType;
    never = neverType;
    uint8 = mcuType('uint8_t', 1, {
        deserialize: (buffer, offset) => buffer.readUInt8(offset),
        serialize: (buffer, offset, value) => buffer.writeUInt8(value, offset),
    });
    uint16 = mcuType('uint16_t', 2, {
        deserialize: (buffer, offset) => buffer.readUInt16LE(offset),
        serialize: (buffer, offset, value) => buffer.writeUInt16LE(value, offset),
    });
    uint32 = mcuType('uint32_t', 4, {
        deserialize: (buffer, offset) => buffer.readUInt32LE(offset),
        serialize: (buffer, offset, value) => buffer.writeUInt32LE(value >>> 0, offset),
    });
    uint64 = mcuType('uint64_t', 8, {
        deserialize: (buffer, offset) => buffer.readBigUInt64LE(offset),
        serialize: (buffer, offset, value) => buffer.writeBigUInt64LE(value, offset),
    });
    uint = this.uint32;
    int8 = mcuType('int8_t', 1, {
        deserialize: (buffer, offset) => buffer.readInt8(offset),
        serialize: (buffer, offset, value) => buffer.writeInt8(value, offset),
    });
    int16 = mcuType('int16_t', 2, {
        deserialize: (buffer, offset) => buffer.readInt16LE(offset),
        serialize: (buffer, offset, value) => buffer.writeInt16LE(value, offset),
    });
    int32 = mcuType('int32_t', 4, {
        deserialize: (buffer, offset) => buffer.readInt32LE(offset),
        serialize: (buffer, offset, value) => buffer.writeInt32LE(value, offset),
    });
    int64 = mcuType('int64_t', 8, {
        deserialize: (buffer, offset) => buffer.readBigInt64LE(offset),
        serialize: (buffer, offset, value) => buffer.writeBigInt64LE(value, offset),
    });
    int = this.int32;
    float = mcuType('float_t', 4, {
        float: true,
        deserialize: (buffer, offset) => buffer.readFloatLE(offset),
        serialize: (buffer, offset, value) => buffer.writeFloatLE(value, offset),
    });
    double = mcuType('double_t', 8, {
        float: true,
        deserialize: (buffer, offset) => buffer.readDoubleLE(offset),
        serialize: (buffer, offset, value) => buffer.writeDoubleLE(value, offset),
    });
    bool = mcuType('bool', 4, {
        deserialize: (buffer, offset) => buffer.readInt32LE(offset) !== 0,
        serialize: (buffer, offset, value) => buffer.writeInt32LE(value ? 1 : 0, offset),
    });
    arrayOf = makeArray;
    buffer = makeBuffer;
    typedArrayOf = makeTypedArray;
    pointerOf = makePointerType(this.uint32);
    ref = makeReferenceType(this.uint32);
    enum = makeEnum;
    flags = makeFlags;
    struct = makeStructure;
    union = makeUnion;
    span = makeSpan;
    function = makeFunctionType;
    peripheral = makePeripheral;
    narrow = narrowType;
}

export const t = new MCUTypes();

const InStackBreakpoint = Buffer.from(
    // biome-ignore format: 16-bit THUMB instruction
    [
        0x00, 0xbe, // bkpt #0
        0xfd, 0xe7, // b #0
    ],
);

const registerSize = t.uint32.size;
const volatileRegisters = ['R0', 'R1', 'R2', 'R3', 'R9', 'R12', 'R13', 'R14', 'R15', 'XPSR'] as const;
const argumentRegisters = ['R0', 'R1', 'R2', 'R3'] as const;
const resultRegisters = ['R0', 'R1', 'R2', 'R3'] as const;

export const armCall = makeCallConvention((ctx, address, _name, returnType, ...argumentTypes) => {
    const { link, breakpoint } = ctx;
    let stackSize = 0;
    let stackAlign = t.uint64.size;
    const stackOffsets: number[] = [];
    for (const argumentType of argumentTypes) {
        stackSize = alignedCeil(stackSize, Math.max(registerSize, argumentType.align));
        stackAlign = Math.max(stackAlign, argumentType.align);
        stackOffsets.push(stackSize);
        stackSize += argumentType.size;
    }
    if (returnType.size > registerSize * resultRegisters.length) {
        throw new Error(`This type cannot be used as return type, use armComplexCall instead.`);
    }
    stackSize = alignedCeil(stackSize, stackAlign);
    const stackRegisterCount = Math.min(argumentRegisters.length, stackSize / registerSize);
    const stackMemoryOffset = argumentRegisters.length * registerSize;
    const stackMemorySize = stackSize - stackMemoryOffset;
    const resultRegisterCount = Math.min(resultRegisters.length, Math.ceil(returnType.size / registerSize));
    const usedResultRegisters = resultRegisters.slice(0, resultRegisterCount);
    return (...args) => {
        const savedRegisters = link.readRegisters([...volatileRegisters]);
        const writingRegisters = {
            R13: savedRegisters.R13, // SP
            R14: savedRegisters.R14, // LR
            R15: alignedFloor(address, 2), // PC
        } as Record<(typeof volatileRegisters)[number], number>;
        if (breakpoint) {
            writingRegisters.R14 = alignedFloor(breakpoint, 2) + 1; // Thumb
        } else {
            writingRegisters.R13 -= InStackBreakpoint.length;
            writingRegisters.R14 = writingRegisters.R13 + 1; // Thumb
            link.writeMemory(writingRegisters.R13, InStackBreakpoint);
        }
        const release = ctx.allocator.stackAccess(ctx, (size, align) => {
            if (size === undefined || size === 0) {
                return writingRegisters.R13;
            }
            let newSP = writingRegisters.R13 - size;
            if (align !== undefined) {
                newSP = alignedFloor(newSP, align);
            }
            writingRegisters.R13 = newSP;
            return newSP;
        });
        const stackBuffer = Buffer.alloc(stackSize);
        for (let i = 0; i < argumentTypes.length; i++) {
            argumentTypes[i].toRegister(ctx, args[i], stackBuffer, stackOffsets[i]);
        }
        const finalizer = release();
        for (let i = 0; i < stackRegisterCount; i++) {
            writingRegisters[argumentRegisters[i]] = stackBuffer.readUInt32LE(i * registerSize);
        }
        if (stackMemorySize > 0) {
            writingRegisters.R13 = alignedFloor(writingRegisters.R13 - stackMemorySize, stackAlign);
            link.writeMemory(writingRegisters.R13, stackBuffer.subarray(stackMemoryOffset));
        }
        link.writeRegisters(writingRegisters);
        return (error?: Error | null) => {
            if (error) {
                const PC = addressToString(ctx.symbolAddresses, link.readRegister('R15'));
                const LR = addressToString(ctx.symbolAddresses, link.readRegister('R14'));
                const FUNC = addressToString(ctx.symbolAddresses, writingRegisters.R15);
                const BKPT = addressToString(ctx.symbolAddresses, writingRegisters.R14);
                const nativeRegisters = { PC, LR, FUNC, BKPT };
                Object.assign(error, { nativeRegisters });
                throw error;
            }
            const outArgs = usedResultRegisters.map((reg) => link.readRegister(reg));
            const outArgBuffer = Buffer.allocUnsafe(outArgs.length * registerSize);
            for (let i = 0; i < outArgs.length; i++) {
                outArgBuffer.writeUInt32LE(outArgs[i], registerSize * i);
            }
            finalizer.finalize();
            link.writeRegisters(savedRegisters);
            return returnType.fromRegister(ctx, outArgBuffer, 0);
        };
    };
});

export const armCompositeCall = makeCompositeCall(armCall, t.ref.out);
