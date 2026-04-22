import { deserialize, mcuType, serialize } from '../core.js';
import type { MCUTypeDef, ToJsType } from '../types.js';

/**
 * Construct an enum type.
 * @param name Enum type name.
 * @param baseType Base type.
 * @param enumDef Enum definition. Keys are enum names, values are enum values.
 */
export function makeEnum<B extends MCUTypeDef, T extends { [key: string]: ToJsType<B> }>(
    name: string,
    baseType: B,
    enumDef: T,
) {
    const enumDefLookup = new Map<ToJsType<B>, keyof T>();
    for (const [enumKey, enumValue] of Object.entries(enumDef)) {
        enumDefLookup.set(enumValue, enumKey as keyof T);
    }
    return mcuType(name, baseType.size, {
        align: baseType.align,
        symbols: baseType.symbols as B['symbols'],
        deserialize: (buffer, ctx, addr) => {
            const baseValue = deserialize(ctx, baseType, buffer, addr);
            const value = enumDefLookup.get(baseValue);
            if (value === undefined) {
                throw new Error(`Value ${baseValue} cannot converted to enum ${name}`);
            }
            return value;
        },
        serialize: (buffer, value, ctx, addr) => {
            if (!Object.hasOwn(enumDef, value)) {
                throw new Error(`${String(value)} is not a valid key for enum ${name}`);
            }
            const baseValue = enumDef[value];
            serialize(ctx, baseType, baseValue, buffer, addr);
        },
    });
}
