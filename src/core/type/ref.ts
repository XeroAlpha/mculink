import { isLazilyAccessProxy, MemoryAddress, mcuType } from '../core.js';
import type { MCUTypeDef, ToJsType } from '../types.js';

/**
 * Input reference type.
 */
export type InRef<T> = T | null | undefined;

/**
 * Construct an input reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeInReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `${type.name}*`;
    return mcuType<InRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: (buffer, offset, ctx) => {
            const address = pointerType.fromRegister(ctx, buffer, offset);
            if (address === 0) {
                return null;
            }
            // prevent circular reference
            return type.lazilyAccess(ctx, address);
        },
        toMemory: (ctx, addr, value, buffer, offset) => {
            if (value === undefined || value === null) {
                return pointerType.toMemory(ctx, addr, 0, buffer, offset);
            }
            if (typeof value === 'object' && isLazilyAccessProxy(value)) {
                return pointerType.toMemory(ctx, addr, value[MemoryAddress], buffer, offset);
            }
            throw new Error(`Ambiguous operation. Use pointer type instead.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (value === undefined || value === null) {
                return pointerType.toRegister(ctx, 0, buffer, offset);
            }
            if (isLazilyAccessProxy(value)) {
                return pointerType.toRegister(ctx, value[MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            type.toMemory(ctx, alloc.address, value);
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Output reference type.
 */
export type OutRef<T> = [T?];

/**
 * Construct an output reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeOutReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Out_ ${type.name}*`;
    return mcuType<OutRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: () => {
            throw new Error(`Reference type ${name} can only be used in function parameters.`);
        },
        toMemory: () => {
            throw new Error(`Cannot change the value of reference type ${name}.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (isLazilyAccessProxy(value[0])) {
                return pointerType.toRegister(ctx, value[0][MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            alloc.finalize = () => {
                value[0] = type.fromMemory(ctx, alloc.address);
            };
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Input/output reference type.
 */
export type InoutRef<T> = [T];

/**
 * Construct an input/output reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeInoutReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Inout_ ${type.name}*`;
    return mcuType<InoutRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: () => {
            throw new Error(`Reference type ${name} can only be used in function parameters.`);
        },
        toMemory: () => {
            throw new Error(`Cannot change the value of reference type ${name}.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (isLazilyAccessProxy(value[0])) {
                return pointerType.toRegister(ctx, value[0][MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            type.toMemory(ctx, alloc.address, value[0]);
            alloc.finalize = () => {
                value[0] = type.fromMemory(ctx, alloc.address);
            };
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Reference type constructor.
 */
export type ReferenceType = {
    <T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    in<T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    out<T extends MCUTypeDef>(type: T): MCUTypeDef<OutRef<ToJsType<T>>>;
    inout<T extends MCUTypeDef>(type: T): MCUTypeDef<InoutRef<ToJsType<T>>>;
};

/**
 * Construct a reference type constructor.
 * @param pointerType Underlying primitive type of the pointer.
 */
export function makeReferenceType(pointerType: MCUTypeDef<number>) {
    const ref: ReferenceType = <T extends MCUTypeDef>(type: T) => makeInReference(pointerType, type);
    ref.in = ref;
    ref.out = <T extends MCUTypeDef>(type: T) => makeOutReference(pointerType, type);
    ref.inout = <T extends MCUTypeDef>(type: T) => makeInoutReference(pointerType, type);
    return ref;
}
