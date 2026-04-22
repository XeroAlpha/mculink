import { type Inspectable, inspect } from 'node:util';
import type {
    EmptyKeyObject,
    LazilyAccessObject,
    LazilyAccessObjectOrValue,
    MCUContext,
    MCUTypeDef,
    MCUTypeDefAccessors,
    SymbolDefintions,
} from './types.js';

export const NativeType = Symbol('nativeType');
export const MemoryAddress = Symbol('memoryAddress');

/**
 * Define a type. Fills in optional parameters.
 */
export function mcuType<T, N extends SymbolDefintions = EmptyKeyObject>(
    name: string,
    size: number,
    accessors: MCUTypeDefAccessors<T, N>,
) {
    const type = { name, size, ...accessors } as MCUTypeDef<T, N>;
    if (!accessors.fromMemory) {
        type.fromMemory = (ctx, addr, buffer) => {
            if (buffer) {
                return accessors.deserialize(buffer, ctx, addr);
            } else {
                const readBuffer = Buffer.allocUnsafe(type.size);
                if (readBuffer.length > 0) {
                    ctx.link.memory.read(addr, readBuffer);
                }
                return accessors.deserialize(readBuffer, ctx, addr);
            }
        };
        if (!accessors.fromRegister) {
            type.fromRegister = (ctx, buffer) => {
                return accessors.deserialize(buffer, ctx);
            };
        }
    }
    if (!accessors.toMemory) {
        type.toMemory = (ctx, addr, value, buffer) => {
            if (buffer) {
                accessors.serialize(buffer, value, ctx, addr);
            } else {
                const writeBuffer = Buffer.allocUnsafe(type.size);
                accessors.serialize(writeBuffer, value, ctx, addr);
                if (writeBuffer.length > 0) {
                    ctx.link.memory.write(addr, writeBuffer);
                }
            }
        };
        if (!accessors.toRegister) {
            type.toRegister = (ctx, value, buffer) => {
                accessors.serialize(buffer, value, ctx);
            };
        }
    }
    if (!Number.isSafeInteger(type.size) || type.size < 0) {
        throw new Error(`Invalid size for type ${type.name}: ${type.size}`);
    }
    if (type.align === undefined) {
        type.align = type.size > 1 ? type.size : 1;
    }
    if (!Number.isSafeInteger(type.align) || type.align < 0) {
        throw new Error(`Invalid align for type ${type.name}: ${type.align}`);
    }
    if (type.fromRegister === undefined) {
        type.fromRegister = () => {
            throw new Error(`Invalid return type ${type.name}.`);
        };
    }
    if (type.toRegister === undefined) {
        type.toRegister = () => {
            throw new Error(`Invalid parameter type ${type.name}.`);
        };
    }
    if (!accessors.lazilyAccess) {
        type.lazilyAccess = type.fromMemory as MCUTypeDef<T>['lazilyAccess']; // primitive
    }
    if (!accessors.symbols) {
        type.symbols = {} as N;
    }
    return type;
}

/**
 * Deserialize data from memory or a buffer into a value.
 * @param ctx MCU call context.
 * @param type MCU type definition.
 * @param buffer Optional buffer.
 * @param addr Optional memory address.
 * @returns Deserialized value.
 */
export function deserialize<T>(ctx: MCUContext, type: MCUTypeDef<T>, buffer: Buffer | undefined, addr?: number): T {
    if (addr !== undefined) {
        return type.fromMemory(ctx, addr, buffer);
    } else if (buffer !== undefined) {
        return type.fromRegister(ctx, buffer);
    }
    throw new Error(`Cannot deserialize since either address nor buffer is provided.`);
}

/**
 * Serialize a value to memory or a buffer.
 * @param ctx MCU call context.
 * @param type MCU type definition.
 * @param value Value to serialize.
 * @param buffer Optional buffer.
 * @param addr Optional memory address.
 */
export function serialize<T>(
    ctx: MCUContext,
    type: MCUTypeDef<T>,
    value: T,
    buffer: Buffer | undefined,
    addr?: number,
) {
    if (addr !== undefined) {
        type.toMemory(ctx, addr, value, buffer);
    } else if (buffer !== undefined) {
        type.toRegister(ctx, value, buffer);
    }
    throw new Error(`Cannot serialize since either address nor buffer is provided.`);
}

/**
 * Create a property descriptor from an address and a type.
 * @param ctx MCU call context.
 * @param addr Memory address.
 * @param type Type definition.
 * @returns Property descriptor.
 */
export function createVariable(ctx: MCUContext, addr: number, type: MCUTypeDef): PropertyDescriptor {
    return {
        get: () => type.lazilyAccess(ctx, addr),
        set: (value) => type.toMemory(ctx, addr, value),
    };
}

function defaultLazilyAccessorHandler<T>(ctx: MCUContext, address: number, type: MCUTypeDef<T>) {
    return type.fromMemory(ctx, address);
}

/**
 * Create a lazy accessor with automatic caching and memory management.
 *
 * The accessor maintains a cache scoped to each `MCUContext`.
 * - **Lazy Initialization**: Invokes the handler only if the object at the specific address is not already cached.
 * - **Weak Caching**: Uses `WeakRef` to store instances. If the object is garbage collected, it will be re-created on next access.
 *
 * @param handler - Factory function to create the accessor if it's missing from the cache.
 */
export function createLazilyAccessor<T>(
    handler: (ctx: MCUContext, address: number, type: MCUTypeDef<T>) => T = defaultLazilyAccessorHandler,
): (ctx: MCUContext, addr: number) => LazilyAccessObjectOrValue<T> {
    const cache = new WeakMap<
        MCUContext,
        {
            map: Map<number, WeakRef<LazilyAccessObjectOrValue<T & object>>>;
            finalizationRegistry: FinalizationRegistry<number>;
        }
    >();
    // must strip this type
    return function (this: MCUTypeDef<T>, ctx: MCUContext, address: number) {
        let cachedMap = cache.get(ctx);
        if (!cachedMap) {
            const map = new Map();
            cachedMap = {
                map,
                finalizationRegistry: new FinalizationRegistry((key) => map.delete(key)),
            };
            cache.set(ctx, cachedMap);
        }
        const cachedObj = cachedMap.map.get(address)?.deref();
        if (cachedObj !== undefined) {
            return cachedObj;
        }
        const value = handler(ctx, address, this);
        if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
            const lazilyAccessValue = markAsLazilyAccessObject(value, this, address) as LazilyAccessObjectOrValue<
                T & object
            >;
            cachedMap.map.set(address, new WeakRef(lazilyAccessValue));
            cachedMap.finalizationRegistry.register(lazilyAccessValue, address);
            return lazilyAccessValue;
        }
        return value as LazilyAccessObjectOrValue<T>;
    };
}

/**
 * Create a lazy proxy accessor that dynamically intercepts property access.
 *
 * On first access, it constructs a `Proxy` object that delegates specific property
 * operations (get/set) to the provided handlers, while keeping other properties
 * on the base object. The resulting proxy is automatically cached (via `createLazilyAccessor`).
 *
 * @param handlers - Configuration object defining the base factory and property interception logic.
 */
export function createLazilyProxyAccesser<T extends object>(handlers: {
    baseObjectFactory(ctx: MCUContext, address: number): T;
    has(p: string): boolean;
    get(ctx: MCUContext, address: number, p: string): unknown;
    set(ctx: MCUContext, address: number, p: string, newValue: unknown): boolean;
}) {
    return createLazilyAccessor<T>((ctx, address, type) => {
        const baseObject = handlers.baseObjectFactory(ctx, address);
        Object.defineProperty(baseObject, inspect.custom, {
            value: ((depth, inspectOptions) => {
                if (depth < 0) {
                    return `[Object ${type.name}]`;
                }
                return inspect(type.fromMemory(ctx, address), {
                    ...inspectOptions,
                    depth: inspectOptions.depth! - 1,
                });
            }) as Inspectable[typeof inspect.custom],
        });
        Object.defineProperty(baseObject, Symbol.toStringTag, { value: type.name });
        const proxy = new Proxy(baseObject, {
            get(target, p) {
                if (typeof p === 'string' && handlers.has(p)) {
                    return handlers.get(ctx, address, p);
                }
                return Reflect.get(target, p);
            },
            getOwnPropertyDescriptor(target, p) {
                if (typeof p === 'string' && handlers.has(p)) {
                    return {
                        configurable: false,
                        enumerable: true,
                        get: () => handlers.get(ctx, address, p),
                        set: (value) => handlers.set(ctx, address, p, value),
                    };
                }
                return Reflect.getOwnPropertyDescriptor(target, p);
            },
            set(target, p, newValue) {
                if (typeof p === 'string' && handlers.has(p)) {
                    return handlers.set(ctx, address, p, newValue);
                }
                return Reflect.set(target, p, newValue);
            },
        });
        return proxy;
    });
}

/**
 * Mark an object as a dynamic view.
 * @param value Object.
 * @param type Type definition.
 * @param address Memory address.
 */
export function markAsLazilyAccessObject<T>(value: T, type: MCUTypeDef<T>, address: number) {
    if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
        Object.defineProperty(value, NativeType, { value: type });
        Object.defineProperty(value, MemoryAddress, { value: address });
    }
    return value as LazilyAccessObjectOrValue<T>;
}

/**
 * Check whether an object is a dynamic view.
 * @param value Object.
 */
export function isLazilyAccessProxy<T>(value: T): value is LazilyAccessObject<T> {
    if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
        return (
            (value as LazilyAccessObject<T>)[NativeType] !== undefined &&
            (value as LazilyAccessObject<T>)[MemoryAddress] !== undefined
        );
    }
    return false;
}

/**
 * Mark a type definition as having an undetermined size. Set `type.size` explicitly to specify it.
 * @param type Type definition.
 */
export function markAsIncompleteType<T extends MCUTypeDef>(type: T) {
    let definedSize: number | undefined;
    Object.defineProperty(type, 'size', {
        configurable: true,
        enumerable: true,
        get() {
            if (definedSize !== undefined) {
                return definedSize;
            }
            throw new Error(`Cannot determine the size of incomplete type ${type.name}.`);
        },
        set(value) {
            definedSize = Number.isNaN(value) ? undefined : value;
        },
    });
    return type;
}

/**
 * Take a snapshot of a dynamic view, converting it into a plain data object.
 *
 * Modifications to the snapshot do not affect memory.
 *
 * If the input is not a dynamic view, it is returned as-is.
 * @param ctx MCU call context.
 * @param value Dynamic view.
 */
export function makeSnapshot<T>(ctx: MCUContext, value: T) {
    if (isLazilyAccessProxy(value)) {
        const nativeType = value[NativeType];
        const memoryAddr = value[MemoryAddress];
        if (nativeType !== undefined && memoryAddr !== undefined) {
            return nativeType.fromMemory(ctx, memoryAddr);
        }
    }
    return value;
}
