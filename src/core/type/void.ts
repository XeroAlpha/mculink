import { mcuType } from '../core.js';

/**
 * `void` type.
 */
export const voidType = mcuType<void>('void_t', 0, {
    fromMemory: () => undefined,
    toMemory: (_ctx, _addr, _value, buffer, offset) => (buffer ? offset : undefined),
    fromRegister: () => undefined,
});

/**
 * `void` type.
 */
export type VoidType = typeof voidType;
