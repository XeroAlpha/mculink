import { alignedCeil } from '../../util/align.js';
import { createLazilyProxyAccesser, deserialize, mcuType, serialize } from '../core.js';
import type { MCUSymbolDef, MCUTypeDef, SymbolDefintions, ToJsType } from '../types.js';

export type StructDefToTypeMap<T extends Record<string, MCUTypeDef | [type: MCUTypeDef, offset?: number]>> = {
    [K in keyof T]: T[K] extends MCUTypeDef ? T[K] : T[K] extends [infer U extends MCUTypeDef, number?] ? U : never;
};

/**
 * Construct a struct type.
 * @param name Struct type name.
 * @param structDef Struct definition. Keys are field names, values are field types or `[type, offset]` tuples.
 * @param align Optional alignment. Defaults to the field's own alignment.
 */
export function makeStructure<T extends Record<string, MCUTypeDef | [type: MCUTypeDef, offset?: number]>>(
    name: string,
    structDef: T,
    align?: number,
) {
    type StructDef = StructDefToTypeMap<T>;
    let size = 0;
    const entryMap = new Map<string, { type: MCUTypeDef; offset: number; nextOffset: number }>();
    const objectTemplate = {} as {
        [K in keyof T]: ToJsType<StructDef[K]>;
    };
    const symbols = {} as {
        [K in keyof T]: MCUSymbolDef<StructDef[K]>;
    };
    let maxAlign = align ?? 1;
    let nextOffset = 0;
    for (const [key, def] of Object.entries(structDef)) {
        const type = Array.isArray(def) ? def[0] : def;
        let offset = Array.isArray(def) ? (def[1] ?? 0) : nextOffset;
        const itemAlign = align ?? type.align;
        maxAlign = Math.max(maxAlign, itemAlign);
        offset = alignedCeil(offset, itemAlign);
        nextOffset = offset + type.size;
        entryMap.set(key, { type, offset, nextOffset });
        (objectTemplate as Record<string, unknown>)[key] = undefined;
        (symbols as SymbolDefintions)[key] = { type, address: offset };
        size = Math.max(size, nextOffset);
    }
    size = alignedCeil(size, maxAlign);
    const structType = mcuType(name, size, {
        align: maxAlign,
        symbols,
        deserialize: (buffer, ctx, addr) => {
            const obj = { ...objectTemplate };
            for (const [key, { type, offset, nextOffset }] of entryMap.entries()) {
                (obj as Record<string, unknown>)[key] = deserialize(
                    ctx,
                    type,
                    buffer.subarray(offset, nextOffset),
                    addr !== undefined ? addr + offset : undefined,
                );
            }
            return obj;
        },
        serialize: (buffer, value, ctx, addr) => {
            for (const [key, { type, offset, nextOffset }] of entryMap.entries()) {
                serialize(
                    ctx,
                    type,
                    value[key],
                    buffer.subarray(offset, nextOffset),
                    addr !== undefined ? addr + offset : undefined,
                );
            }
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...objectTemplate };
            },
            has(p) {
                return entryMap.has(p);
            },
            get(ctx, address, p) {
                const { type, offset } = entryMap.get(p)!;
                return type.lazilyAccess(ctx, address + offset);
            },
            set(ctx, address, p, newValue) {
                const { type, offset } = entryMap.get(p)!;
                type.toMemory(ctx, address + offset, newValue);
                return true;
            },
        }),
    });
    return structType;
}
