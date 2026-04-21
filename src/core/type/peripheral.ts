import type { MCUTypeDef } from '../types.js';

const peripheralTypeMap = new WeakMap<MCUTypeDef, MCUTypeDef>();

/**
 * Construct the peripheral type for a given type that enforces direct memory access.
 * @param type Type definition.
 */
export function makePeripheral<T extends MCUTypeDef>(type: T) {
    let peripheralType = peripheralTypeMap.get(type) as T;
    if (peripheralType === undefined) {
        peripheralType = Object.create(type) as T;
        peripheralType.name = `_Peripheral_ ${type.name}`;
        peripheralType.fromMemory = (ctx, addr) => type.fromMemory(ctx, addr);
        peripheralType.toMemory = (ctx, addr, value) => type.toMemory(ctx, addr, value);
        peripheralTypeMap.set(type, peripheralType);
    }
    return peripheralType;
}
