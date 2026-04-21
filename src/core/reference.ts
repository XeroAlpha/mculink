import { createVariable, MemoryAddress, NativeType } from './core.js';
import type { MCUSymbol } from './symbol.js';
import { createSymbol } from './symbol.js';
import type { MCUContext, MCUTypeDef, ToJsType } from './types.js';

/**
 * Direct manipulation interfaces to specific memory addresses.
 * They provide immediate read/write access and can be assigned to pointer-type variables.
 */
export interface MCUReference<T extends MCUTypeDef> {
    readonly [NativeType]: T;
    readonly [MemoryAddress]: number;
    readonly address: number;
    value: ToJsType<T>;
    readonly symbol: MCUSymbol<T>;
}

export function createReference<T extends MCUTypeDef, B = object>(
    ctx: MCUContext,
    address: number,
    type: T,
    baseObject?: B,
) {
    const ref = (baseObject ?? {}) as B & MCUReference<typeof type>;
    Object.defineProperty(ref, 'address', {
        configurable: true,
        enumerable: true,
        value: address,
    });
    Object.defineProperty(ref, 'value', {
        configurable: true,
        enumerable: true,
        ...createVariable(ctx, address, type),
    });
    Object.defineProperty(ref, 'symbol', {
        configurable: true,
        enumerable: true,
        value: createSymbol(ctx, address, type),
    });
    Object.defineProperty(ref, NativeType, {
        configurable: false,
        enumerable: false,
        value: type,
    });
    Object.defineProperty(ref, MemoryAddress, {
        configurable: false,
        enumerable: false,
        value: address,
    });
    return ref;
}
