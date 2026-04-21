import { alignedCeil } from '../../util/align.js';
import { createLazilyProxyAccesser, deserialize, mcuType, serialize } from '../core.js';
import type { MCUSymbolDef, MCUTypeDef, SymbolDefintions, ToJsType } from '../types.js';

/**
 * Construct a union type.
 * @param name Union type name.
 * @param unionDef Union definition. Keys are member names, values are member types.
 */
export function makeUnion<T extends Record<string, MCUTypeDef>>(name: string, unionDef: T) {
    const def = { ...unionDef };
    const entries = Object.entries(def);
    const objectTemplate = {} as {
        [K in keyof T]: ToJsType<T[K]>;
    };
    const symbols = {} as {
        [K in keyof T]: MCUSymbolDef<T[K]>;
    };
    let maxSize = 0;
    let maxAlign = 1;
    for (const [key, def] of entries) {
        maxAlign = Math.max(maxAlign, def.align);
        maxSize = Math.max(maxSize, def.size);
        (objectTemplate as Record<string, unknown>)[key] = undefined;
        (symbols as SymbolDefintions)[key] = { type: def, address: 0 };
    }
    maxSize = alignedCeil(maxSize, maxAlign);
    const unionType = mcuType(name, maxSize, {
        align: maxAlign,
        symbols,
        deserialize: (buffer, offset, ctx, addr) => {
            const obj = { ...objectTemplate };
            for (const [key, def] of entries) {
                (obj as Record<string, unknown>)[key] = deserialize(ctx, def, buffer, offset, addr);
            }
            return obj;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            for (const [key, def] of entries) {
                serialize(ctx, def, value[key], buffer, offset, addr);
            }
            return offset + maxSize;
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...objectTemplate };
            },
            has(p) {
                return Object.hasOwn(def, p);
            },
            get(ctx, address, p) {
                return def[p].lazilyAccess(ctx, address);
            },
            set(ctx, address, p, newValue) {
                def[p].toMemory(ctx, address, newValue);
                return true;
            },
        }),
    });
    return unionType;
}
