import { type Inspectable, inspect } from 'node:util';
import { MemoryAddress, NativeType } from './core.js';
import type { MCUContext, MCUFunctionDef, MCUSymbolDef, MCUTypeDef, SymbolDefintions, ToJsFunction } from './types.js';

/**
 * Structured representations of named locations in MCU memory that carry complete type and structural information.
 * They allow you to navigate complex nested data structures in a type-safe manner.
 */
export type MCUSymbol<T extends MCUTypeDef = MCUTypeDef> = {
    [NativeType]: T;
    [MemoryAddress]: number;
} & MCUSymbolMap<T['symbols']>;

/**
 * Symbol tree. Can be used to access symbols and sub-symbols in a hierarchical structure.
 */
export type MCUSymbolMap<T extends SymbolDefintions = SymbolDefintions> = {
    readonly [K in keyof T]: MCUSymbol<Exclude<T[K], undefined>['type']>;
};

export type ToSymbol<T extends MCUTypeDef | MCUFunctionDef> = T extends MCUTypeDef
    ? MCUSymbol<T>
    : T extends MCUFunctionDef
      ? MCUSymbol<MCUTypeDef<ToJsFunction<T>>>
      : never;

export function createSymbol<T extends MCUTypeDef>(ctx: MCUContext, address: number, type: T) {
    const target = {} as unknown as MCUSymbol<T>;
    for (const [key, symbol] of Object.entries<MCUSymbolDef>(type.symbols)) {
        if (symbol) {
            Object.defineProperty(target, key, {
                configurable: false,
                enumerable: true,
                get: () => createSymbol(ctx, address + symbol.address, symbol.type),
            });
        }
    }
    Object.defineProperty(target, NativeType, {
        configurable: false,
        enumerable: false,
        value: type,
    });
    Object.defineProperty(target, MemoryAddress, {
        configurable: false,
        enumerable: false,
        value: address,
    });
    Object.defineProperty(target, inspect.custom, {
        configurable: false,
        enumerable: false,
        value: ((depth, inspectOptions) => {
            if (depth < 0) {
                return `[Symbol ${type.name}]`;
            }
            return inspect(
                { ...target },
                {
                    ...inspectOptions,
                    depth: inspectOptions.depth! - 1,
                },
            );
        }) as Inspectable[typeof inspect.custom],
    });
    Object.defineProperty(target, Symbol.toStringTag, {
        configurable: false,
        enumerable: false,
        value: type.name,
    });
    return target;
}
