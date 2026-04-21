import { createLazilyProxyAccesser, deserialize, mcuType, serialize } from '../core.js';
import type { MCUSymbolDef, MCUTypeDef, ToJsType } from '../types.js';

/**
 * Construct an array type.
 * @param type Array element type.
 * @param length Array length.
 */
export function makeArray<T extends MCUTypeDef>(type: T, length: number) {
    const name = `${type.name}[${length}]`;
    const itemSize = type.size;
    const size = itemSize * length;
    const symbols = new Proxy({} as { [k: number]: MCUSymbolDef<T> }, {
        get(_, p) {
            const numP = Number(p);
            if (!Number.isNaN(numP) && numP >= 0 && numP < length) {
                return { type, address: itemSize * numP };
            }
            return undefined;
        },
    });
    const arrayType = mcuType(name, size, {
        align: itemSize,
        symbols,
        deserialize: (buffer, offset, ctx, addr) => {
            const value = new Array<ToJsType<T>>(length);
            for (let i = 0; i < length; i++) {
                value[i] = deserialize(
                    ctx,
                    type,
                    buffer,
                    offset + itemSize * i,
                    addr !== undefined ? addr + itemSize * i : undefined,
                );
            }
            return value;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            for (let i = 0; i < length; i++) {
                serialize(
                    ctx,
                    type,
                    value[i],
                    buffer,
                    offset + itemSize * i,
                    addr !== undefined ? addr + itemSize * i : undefined,
                );
            }
            return offset + size;
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return new Array(length).fill(undefined) as ToJsType<T>[];
            },
            has(p) {
                if (p === 'length') {
                    return true;
                }
                const numP = Number(p);
                return !Number.isNaN(numP) && numP >= 0 && numP < length;
            },
            get(ctx, address, p) {
                if (p === 'length') {
                    return length;
                }
                const numP = Number(p);
                return type.lazilyAccess(ctx, address + itemSize * numP);
            },
            set(ctx, address, p, newValue) {
                if (p === 'length') {
                    return false;
                }
                const numP = Number(p);
                type.toMemory(ctx, address + itemSize * numP, newValue);
                return true;
            },
        }),
    });
    return arrayType;
}
