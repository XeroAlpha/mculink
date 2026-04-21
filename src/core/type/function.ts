import { createLazilyAccessor, markAsIncompleteType, mcuType } from '../core.js';
import type { MCUFunctionDef, ToJsFunction } from '../types.js';

/**
 * Construct a function type.
 * @param name Function type name.
 * @param def Function definition.
 */
export function makeFunctionType<F extends MCUFunctionDef>(name: string, def: F) {
    const type = mcuType(name, 0, {
        fromMemory: (ctx, addr) => {
            return def(ctx, addr, name) as ToJsFunction<F>;
        },
        toMemory: () => {
            throw new Error(`Cannot change the value of function type ${name}.`);
        },
        lazilyAccess: createLazilyAccessor<ToJsFunction<F>>(),
    });
    return markAsIncompleteType(type);
}
