import { mcuType } from '../core.js';

/**
 * `void` type.
 */
export const voidType = mcuType<void>('void_t', 0, {
    fromMemory: () => undefined,
    toMemory: () => {},
    fromRegister: () => undefined,
});

/**
 * `void` type.
 */
export type VoidType = typeof voidType;
