import { readFileSync } from 'node:fs';
import { analyzeELF } from '../util/elf.js';
import { addressToString, offsetAddressMap, resolveAddress } from './address.js';
import { DefaultAllocator } from './allocation.js';
import {
    createVariable,
    isLazilyAccessProxy,
    MemoryAddress,
    makeSnapshot,
    markAsLazilyAccessObject,
    NativeType,
} from './core.js';
import { createReference } from './reference.js';
import { createSymbol } from './symbol.js';
import { makeFunctionType } from './type/function.js';
import { MCUSpan } from './type/span.js';
import type {
    AppendDefinition,
    EmptyKeyObject,
    MCUCall,
    MCUCallOptions,
    MCUContext,
    MCUFunctionDef,
    MCULink,
    MCUTypeDef,
    SymbolAddresses,
} from './types.js';

function mcuDefine(
    ctx: MCUContext,
    view: MCUCall,
    name: string,
    address: number,
    typeOrBinder: MCUTypeDef | MCUFunctionDef,
) {
    if (typeof typeOrBinder === 'function') {
        const functionType = makeFunctionType(name, typeOrBinder);
        Object.defineProperty(view, name, {
            configurable: true,
            enumerable: true,
            value: markAsLazilyAccessObject(typeOrBinder(ctx, address, name), functionType, address),
        });
        Object.defineProperty(view.symbols, name, {
            configurable: true,
            enumerable: true,
            value: createSymbol(ctx, address, functionType),
        });
    } else {
        Object.defineProperty(view, name, {
            configurable: true,
            enumerable: true,
            ...createVariable(ctx, address, typeOrBinder),
        });
        Object.defineProperty(view.symbols, name, {
            configurable: true,
            enumerable: true,
            value: createSymbol(ctx, address, typeOrBinder),
        });
    }
}

/**
 * Initialize a {@link MCUCall} instance.
 *
 * Sets up the environment for calling MCU functions, linking the low-level hardware connection with symbol definitions and configuration options.
 *
 * @param link The low-level hardware link instance (e.g., JLink).
 * @param symbolSource The source for symbol definitions, such as an ELF file path, URL, buffer, or a raw symbol table.
 * @param options Configuration options for the instance.
 */
export function mcuCall(
    link: MCULink,
    symbolSource?: string | URL | Buffer | SymbolAddresses | null,
    options?: MCUCallOptions,
): MCUCall {
    let symbolAddresses: SymbolAddresses;
    if (Buffer.isBuffer(symbolSource)) {
        symbolAddresses = analyzeELF(symbolSource).symbolAddresses;
    } else if (typeof symbolSource === 'string' || symbolSource instanceof URL) {
        symbolAddresses = analyzeELF(readFileSync(symbolSource)).symbolAddresses;
    } else if (typeof symbolSource === 'object' && symbolSource !== null) {
        symbolAddresses = symbolSource;
    } else {
        symbolAddresses = {};
    }
    if (options?.memoryOffset !== undefined) {
        symbolAddresses = offsetAddressMap(symbolAddresses, options.memoryOffset);
    }
    const allocator = options?.allocator ?? new DefaultAllocator();
    const breakpoint = resolveAddress(options?.breakpoint, symbolAddresses, 'BKPT_FUNCTION');
    const heapBase = resolveAddress(options?.heap, symbolAddresses, 'HEAP_BASE');
    const heapLimit = resolveAddress(options?.heapLimit, symbolAddresses, 'HEAP_LIMIT');
    const heapLimitBySize = heapBase !== undefined && options?.heapSize ? heapBase + options.heapSize : undefined;
    const ctx = {
        link,
        allocator,
        symbolAddresses,
        breakpoint,
        callTimeout: options?.callTimeout ?? Infinity,
    } as MCUContext;
    if (heapBase) {
        ctx.allocator.heapAccess(ctx, heapBase, heapLimitBySize ?? heapLimit);
    }
    const addressOf = (symbolOrAddress: string | number | Record<never, never>) => {
        if (symbolOrAddress === undefined) {
            throw new Error(`Symbol is undefined`);
        }
        if (typeof symbolOrAddress === 'string' || typeof symbolOrAddress === 'number') {
            return resolveAddress(symbolOrAddress, symbolAddresses);
        } else if (isLazilyAccessProxy(symbolOrAddress)) {
            return symbolOrAddress[MemoryAddress];
        }
        throw new Error(`Symbol ${symbolOrAddress} not found`);
    };
    const symbols = {};
    const resultProto: MCUCall = {
        define<T extends AppendDefinition<EmptyKeyObject>>(def: T) {
            for (const [name, typeOrBinder] of Object.entries(def)) {
                if (typeOrBinder === undefined) {
                    continue;
                }
                if (name in this) {
                    throw new Error(`${name} is already defined in MCUCall.`);
                }
                const address = symbolAddresses[name];
                mcuDefine(ctx, this, name, address, typeOrBinder);
            }
            return this as MCUCall<T>;
        },
        defineOptional<T extends AppendDefinition<EmptyKeyObject>>(def: T) {
            for (const [name, typeOrBinder] of Object.entries(def)) {
                if (typeOrBinder === undefined) {
                    continue;
                }
                if (name in this) {
                    throw new Error(`${name} is already defined in MCUCall.`);
                }
                try {
                    const address = symbolAddresses[name];
                    mcuDefine(ctx, this, name, address, typeOrBinder);
                } catch (_err) {
                    // symbol not found, skip
                }
            }
            return this as MCUCall<T>;
        },
        tryDefine<T extends AppendDefinition<EmptyKeyObject>>(def: T): this is MCUCall<T> {
            for (const [name, typeOrBinder] of Object.entries(def)) {
                if (typeOrBinder === undefined) {
                    continue;
                }
                if (name in this) {
                    return false;
                }
                try {
                    const address = symbolAddresses[name];
                    mcuDefine(ctx, this, name, address, typeOrBinder);
                } catch (_err) {
                    return false;
                }
            }
            return true;
        },
        addressOf,
        typeOf(symbol) {
            if (symbol === undefined) {
                throw new Error(`Symbol is undefined`);
            }
            return symbol[NativeType];
        },
        sizeOf(symbol) {
            if (symbol === undefined) {
                throw new Error(`Symbol is undefined`);
            }
            return symbol[NativeType].size;
        },
        new(type) {
            const alloc = ctx.allocator.allocate(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from heap.`);
            }
            return createReference(ctx, alloc.address, type, alloc);
        },
        cast: (symbolOrAddress, type) => {
            const address = addressOf(symbolOrAddress);
            return type.lazilyAccess(ctx, address);
        },
        bind: (symbolOrAddress, def) => {
            const address = addressOf(symbolOrAddress);
            return def(ctx, address, '(anonymous)');
        },
        read(symbolOrAddress, type) {
            const address = addressOf(symbolOrAddress);
            return type.fromMemory(ctx, address);
        },
        write(symbolOrAddress, type, value) {
            const address = addressOf(symbolOrAddress);
            return type.toMemory(ctx, address, value);
        },
        symbolOf(symbolOrAddress, type) {
            const address = addressOf(symbolOrAddress);
            if (type === undefined && isLazilyAccessProxy(symbolOrAddress)) {
                const inferredType = symbolOrAddress[NativeType];
                return createSymbol(ctx, address, inferredType);
            }
            return createSymbol(ctx, address, type!);
        },
        referenceOf(symbolOrAddress, type) {
            const address = addressOf(symbolOrAddress);
            if (type === undefined && isLazilyAccessProxy(symbolOrAddress)) {
                const inferredType = symbolOrAddress[NativeType];
                return createReference(ctx, address, inferredType);
            }
            return createReference(ctx, address, type!);
        },
        spanOf(symbolOrAddress, size) {
            const address = addressOf(symbolOrAddress);
            let inferredSize = size;
            if (inferredSize === undefined && isLazilyAccessProxy(symbolOrAddress)) {
                try {
                    inferredSize = symbolOrAddress[NativeType].size;
                } catch (_err) {
                    // ignore incomplete type
                }
            }
            return new MCUSpan(ctx, address, inferredSize);
        },
        snapshot<T>(value: T) {
            return makeSnapshot(ctx, value);
        },
        ref<T>(value?: T) {
            return [value] as [T];
        },
        locate(symbolOrAddress, searchUpperBound, searchLowerBound) {
            const address = addressOf(symbolOrAddress);
            return addressToString(symbolAddresses, address, searchUpperBound, searchLowerBound);
        },
        context: ctx,
        symbols,
        $: symbols,
        symbolNames: Object.keys(symbolAddresses),
    };
    return Object.create(resultProto);
}
