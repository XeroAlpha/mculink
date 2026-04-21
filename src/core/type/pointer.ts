import { createLazilyAccessor, deserialize, mcuType, serialize } from '../core.js';
import { createSymbol, type MCUSymbol } from '../symbol.js';
import type { MCUTypeDef, ToJsType } from '../types.js';

/**
 * Pointer type.
 */
export interface MCUPointer<T extends MCUTypeDef = MCUTypeDef> {
    address: number;
    value: ToJsType<T>;
    readonly symbol: MCUSymbol<T>;
}

/**
 * Construct a pointer type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Target type the pointer points to.
 */
export function makePointer<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Pointer_ ${type.name}*`;
    return mcuType<MCUPointer<T>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: (buffer, offset, ctx, addr) => {
            const address = deserialize(ctx, pointerType, buffer, offset, addr);
            const ptr = {
                address,
                symbol: createSymbol(ctx, address, type),
            } as MCUPointer<T>;
            // prevent circular reference
            Object.defineProperty(ptr, 'value', {
                configurable: true,
                enumerable: true,
                get: () => type.lazilyAccess(ctx, address),
                set: (value) => type.toMemory(ctx, address, value),
            });
            return ptr;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            return serialize(ctx, pointerType, value.address, buffer, offset, addr);
        },
        lazilyAccess: createLazilyAccessor((ctx, addr) => {
            const getAddress = () => pointerType.fromMemory(ctx, addr);
            const ptr = {} as MCUPointer<T>;
            Object.defineProperty(ptr, 'address', {
                configurable: true,
                enumerable: true,
                get: getAddress,
                set: (value) => pointerType.toMemory(ctx, addr, value),
            });
            Object.defineProperty(ptr, 'value', {
                configurable: true,
                enumerable: true,
                get: () => type.lazilyAccess(ctx, getAddress()),
                set: (value) => type.toMemory(ctx, getAddress(), value),
            });
            Object.defineProperty(ptr, 'symbol', {
                configurable: true,
                enumerable: true,
                get: () => createSymbol(ctx, getAddress(), type),
            });
            return ptr;
        }),
    });
}

/**
 * Construct a pointer type constructor.
 * @param pointerType Underlying primitive type of the pointer.
 */
export function makePointerType(pointerType: MCUTypeDef<number>) {
    return <T extends MCUTypeDef>(type: T) => makePointer(pointerType, type);
}
