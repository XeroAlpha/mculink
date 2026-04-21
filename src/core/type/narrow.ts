import type { MCUTypeDef, ToJsType } from '../types.js';

/**
 * Narrow a type definition.
 * @param type Type definition.
 */
export function narrowType<T extends MCUTypeDef>(type: T) {
    return {
        as<N extends ToJsType<T>>() {
            return type as MCUTypeDef<N, T['symbols']>;
        },
    };
}
