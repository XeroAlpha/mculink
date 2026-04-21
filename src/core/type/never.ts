import { mcuType } from '../core.js';

/**
 * `never` type. Indicating that this function never completes.
 */
export const neverType = mcuType<never>('never_t', 0, {
    fromMemory: () => {
        throw new Error(`Invalid type.`);
    },
    toMemory: () => {
        throw new Error(`Invalid type.`);
    },
});

/**
 * `never` type. Indicating that this function never completes.
 */
export type NeverType = typeof neverType;
