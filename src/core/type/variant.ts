import { mcuType, serialize } from '../core.js';
import type { MCUTypeDef, ToJsType } from '../types.js';

export type VariantValue<T extends MCUTypeDef> = [type: T, value: ToJsType<T>];
export function makeVariantType(size: number) {
    return mcuType<VariantValue<MCUTypeDef>>(`_Variant_(${size})`, size, {
        deserialize: () => {
            throw new Error(`Cannot read variant type because the concrete type is unknown at runtime.`);
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            if (value[0].size > size) {
                throw new Error(`Variant type size overflow: expected at most ${size}, got ${value[0].size}.`);
            }
            return serialize(ctx, value[0], value[1], buffer, offset, addr);
        },
    });
}
