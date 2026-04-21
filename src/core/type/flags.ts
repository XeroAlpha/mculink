import { createLazilyProxyAccesser, deserialize, mcuType, serialize } from '../core.js';
import type { MCUTypeDef, ToJsType } from '../types.js';

/**
 * Construct a flags type.
 * @param name Flags type name.
 * @param baseType Base type.
 * @param flagDef Flags definition. Keys are flag names, values are flag values.
 */
export function makeFlags<B extends MCUTypeDef<number>, T extends { [key: string]: ToJsType<B> }>(
    name: string,
    baseType: B,
    flagDef: T,
) {
    const flagDefEntries = Object.entries(flagDef) as [key: keyof T, flag: ToJsType<B>][];
    const zeroFlagValue = Object.fromEntries(flagDefEntries.map(([k]) => [k, false])) as {
        [K in keyof T]: boolean;
    };
    return mcuType(name, baseType.size, {
        align: baseType.align,
        symbols: baseType.symbols as B['symbols'],
        deserialize: (buffer, offset, ctx, addr) => {
            const baseValue = deserialize(ctx, baseType, buffer, offset, addr);
            const value = { ...zeroFlagValue };
            for (const [key, flag] of flagDefEntries) {
                value[key] = (baseValue & flag) === flag;
            }
            return value;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            let baseValue = 0;
            for (const [key, flag] of flagDefEntries) {
                if (value[key]) {
                    baseValue |= flag;
                }
            }
            return serialize(ctx, baseType, baseValue, buffer, offset, addr);
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...zeroFlagValue };
            },
            has(p) {
                return p in flagDef;
            },
            get(ctx, address, p) {
                const flag = flagDef[p];
                const baseValue = baseType.fromMemory(ctx, address);
                return (baseValue & flag) === flag;
            },
            set(ctx, address, p, newValue) {
                const flag = flagDef[p];
                let baseValue = baseType.fromMemory(ctx, address);
                if (newValue) {
                    baseValue |= flag;
                } else {
                    baseValue &= ~flag;
                }
                baseType.toMemory(ctx, address, baseValue);
                return true;
            },
        }),
    });
}
