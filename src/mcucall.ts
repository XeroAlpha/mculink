import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { type Inspectable, inspect } from 'node:util';
import type { LiteralUnion, Promisable } from 'type-fest';
import { alignedCeil } from './binparse.js';
import { analyzeELF } from './elf.js';
import type { JLink } from './jlink.js';

const NativeType = Symbol('nativeType');
const MemoryAddress = Symbol('memoryAddress');

// biome-ignore lint/complexity/noBannedTypes: T extends Record<...> && keyof T extends never
export type EmptyKeyObject = {};

/**
 * Dynamic view.
 *
 * Accessing a dynamic view serializes/deserializes and synchronizes with MCU memory automatically.
 */
export type LazilyAccessObject<T = object> = T & {
    readonly [NativeType]: MCUTypeDef<T>;
    readonly [MemoryAddress]: number;
};
export type LazilyAccessObjectOrValue<T> = T extends object ? LazilyAccessObject<T> : T;

/**
 * The low-level hardware link instance. See {@link JLink}.
 */
export interface MCULink {
    halt(): boolean;
    isHalted(): boolean;
    resume(): void;
    readMemory(address: number, buffer: Buffer): number;
    writeMemory(address: number, buffer: Buffer): number;
    readRegister(registerName: string): number;
    writeRegister(registerName: string, value: number): void;
    readRegisters<K extends string>(registers: K[]): { [k in K]: number };
    writeRegisters(registers: Record<string, number>): void;
}

/**
 * Symbol table.
 */
export type SymbolAddresses = Record<string, number>;

/**
 * MCU call context.
 */
export interface MCUContext {
    /**
     * MCU interaction interface.
     */
    link: MCULink;

    /**
     * Memory allocator.
     */
    allocator: MCUAllocator;

    /**
     * Symbol table.
     */
    symbolAddresses: SymbolAddresses;

    /**
     * Breakpoint code address.
     */
    breakpoint: number | undefined;

    /**
     * Call timeout in milliseconds.
     */
    callTimeout: number;
}

/**
 * MCUTypeDef interface tag. Stores the corresponding JavaScript type.
 */
export declare const typeTag: unique symbol;

/**
 * Type definition. Describes memory/stack/register storage, serialization, and deserialization.
 */
export interface MCUTypeDef<T = unknown, N extends SymbolDefintions = EmptyKeyObject> {
    [typeTag]: T;

    /**
     * Symbol namespace for the type.
     */
    symbols: N;

    /**
     * Type name (e.g., `char`).
     */
    name: string;

    /**
     * Type size, `sizeof(Type)`, in bytes.
     */
    size: number;

    /**
     * Alignment, `__alignof__(Type)`, in bytes.
     */
    align: number;

    /**
     * Read a value from memory.
     * @param ctx Call context.
     * @param addr Memory address.
     * @param buffer Optional prefetched buffer. Reads from here if available to avoid redundant hardware reads.
     * @param offset Position within the buffer to start reading from.
     */
    fromMemory(ctx: MCUContext, addr: number, buffer?: Buffer, offset?: number): T;

    /**
     * Write a value to memory.
     *
     * If `buffer` is provided, write data into it instead of memory to reduce write overhead.
     * @param ctx Call context.
     * @param addr Memory address.
     * @param value Value to write.
     * @param buffer Optional staging buffer. If provided, data is written here for later sync.
     * @param offset Position within the buffer to start writing.
     * @returns Offset + size written if buffered; otherwise `undefined`.
     */
    toMemory(ctx: MCUContext, addr: number, value: T, buffer?: Buffer, offset?: number): number | undefined;

    /**
     * Returns a lazy-access dynamic view. Data is read from/written to memory only when properties are accessed.
     *
     * Falls back to `fromMemory` if lazy access is not supported.
     * @param ctx Call context.
     * @param addr Memory address.
     */
    lazilyAccess(this: MCUTypeDef<T, N>, ctx: MCUContext, addr: number): LazilyAccessObjectOrValue<T>;

    /**
     * Convert raw register data into a value. Typically used to retrieve function return values.
     * @param ctx Call context.
     * @param buffer Read buffer.
     * @param offset Position within the buffer to start reading from.
     */
    fromRegister(ctx: MCUContext, buffer: Buffer, offset: number): T;

    /**
     * Convert a value into raw register data. Typically used to pass function arguments.
     * @param ctx Call context.
     * @param value Value to write.
     * @param buffer Write buffer.
     * @param offset Position within the buffer to start writing.
     * @returns Offset + size written.
     */
    toRegister(ctx: MCUContext, value: T, buffer: Buffer, offset: number): number;
}

/**
 * JavaScript representation of a type definition.
 */
export type ToJsType<T extends MCUTypeDef> = T[typeof typeTag];

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

/**
 * Symbol definition.
 */
export type MCUSymbolDef<T extends MCUTypeDef = MCUTypeDef> = {
    /**
     * Type definition.
     */
    type: T;
    /**
     * Address offset relative to the parent type.
     */
    address: number;
};
/**
 * Symbol definition table.
 */
export type SymbolDefintions = Partial<Record<string | number, MCUSymbolDef>>;

export type MCUTypeDefAccessors<T, N extends SymbolDefintions = EmptyKeyObject> = Partial<
    Omit<MCUTypeDef<T, N>, typeof typeTag | 'name' | 'size'>
> &
    (
        | Pick<MCUTypeDef<T, N>, 'fromMemory'>
        | {
              fromMemory?: undefined;

              /**
               * Read a value from a buffer. Reads memory if no prefetched buffer is available.
               * @param buffer Buffer to read from.
               * @param offset Position within the buffer to start reading from.
               * @param ctx Call context.
               * @param addr Memory address. Not provided when the source is a register.
               */
              deserialize(buffer: Buffer, offset: number, ctx: MCUContext, addr?: number): T;
          }
    ) &
    (
        | Pick<MCUTypeDef<T, N>, 'toMemory'>
        | {
              toMemory?: undefined;

              /**
               * Write a value to a buffer. Writes to memory if no staging buffer is available.
               * @param buffer Buffer to write to.
               * @param offset Position within the buffer to start writing.
               * @param value Value to write.
               * @param ctx Call context.
               * @param addr Memory address. Not provided when the target is a register.
               * @returns Offset + size written.
               */
              serialize(buffer: Buffer, offset: number, value: T, ctx: MCUContext, addr?: number): number;
          }
    );

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
        type.fromMemory = (ctx, addr, buffer, offset) => {
            if (buffer) {
                return accessors.deserialize(buffer, offset!, ctx, addr);
            } else {
                const readBuffer = Buffer.allocUnsafe(type.size);
                if (readBuffer.length > 0) {
                    ctx.link.readMemory(addr, readBuffer);
                }
                return accessors.deserialize(readBuffer, 0, ctx, addr);
            }
        };
        if (!accessors.fromRegister) {
            type.fromRegister = (ctx, buffer, offset) => {
                return accessors.deserialize(buffer, offset!, ctx);
            };
        }
    }
    if (!accessors.toMemory) {
        type.toMemory = (ctx, addr, value, buffer, offset) => {
            if (buffer) {
                return accessors.serialize(buffer, offset!, value, ctx, addr);
            } else {
                const writeBuffer = Buffer.allocUnsafe(type.size);
                accessors.serialize(writeBuffer, 0, value, ctx, addr);
                if (writeBuffer.length > 0) {
                    ctx.link.writeMemory(addr, writeBuffer);
                }
            }
        };
        if (!accessors.toRegister) {
            type.toRegister = (ctx, value, buffer, offset) => {
                return accessors.serialize(buffer, offset!, value, ctx);
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

/**
 * Deserialize data from memory or a buffer into a value.
 * @param ctx MCU call context.
 * @param type MCU type definition.
 * @param buffer Optional buffer.
 * @param offset Offset within the buffer.
 * @param addr Optional memory address.
 * @returns Deserialized value.
 */
export function deserialize<T>(
    ctx: MCUContext,
    type: MCUTypeDef<T>,
    buffer: Buffer | undefined,
    offset: number | undefined,
    addr?: number,
): T {
    if (addr !== undefined) {
        return type.fromMemory(ctx, addr, buffer, offset);
    } else if (buffer !== undefined && offset !== undefined) {
        return type.fromRegister(ctx, buffer, offset);
    }
    throw new Error(`Cannot deserialize since either address nor buffer is provided.`);
}

/**
 * Serialize a value to memory or a buffer.
 * @param ctx MCU call context.
 * @param type MCU type definition.
 * @param value Value to serialize.
 * @param buffer Optional buffer.
 * @param offset Offset within the buffer.
 * @param addr Optional memory address.
 * @returns Offset + size written if buffered; otherwise `0`.
 */
export function serialize<T>(
    ctx: MCUContext,
    type: MCUTypeDef<T>,
    value: T,
    buffer: Buffer | undefined,
    offset: number | undefined,
    addr?: number,
): number {
    if (addr !== undefined) {
        return type.toMemory(ctx, addr, value, buffer, offset) ?? 0;
    } else if (buffer !== undefined && offset !== undefined) {
        return type.toRegister(ctx, value, buffer, offset);
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
): MCUTypeDef<T>['lazilyAccess'] {
    const cache = new WeakMap<
        MCUContext,
        {
            map: Map<number, WeakRef<LazilyAccessObjectOrValue<T & object>>>;
            finalizationRegistry: FinalizationRegistry<number>;
        }
    >();
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

/**
 * Construct an array type.
 * @param type Array element type.
 * @param length Array length.
 */
export function makeArray<T extends MCUTypeDef>(type: T, length: number) {
    const name = `${type.name}[${length}]`;
    const itemSize = type.size;
    const size = itemSize * length;
    const symbols = new Proxy({} as { [k: number]: MCUSymbolDef<T> }, {
        get(_, p) {
            const numP = Number(p);
            if (!Number.isNaN(numP) && numP >= 0 && numP < length) {
                return { type, address: itemSize * numP };
            }
            return undefined;
        },
    });
    const arrayType = mcuType(name, size, {
        align: itemSize,
        symbols,
        deserialize: (buffer, offset, ctx, addr) => {
            const value = new Array<ToJsType<T>>(length);
            for (let i = 0; i < length; i++) {
                value[i] = deserialize(
                    ctx,
                    type,
                    buffer,
                    offset + itemSize * i,
                    addr !== undefined ? addr + itemSize * i : undefined,
                );
            }
            return value;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            for (let i = 0; i < length; i++) {
                serialize(
                    ctx,
                    type,
                    value[i],
                    buffer,
                    offset + itemSize * i,
                    addr !== undefined ? addr + itemSize * i : undefined,
                );
            }
            return offset + size;
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return new Array(length).fill(undefined) as ToJsType<T>[];
            },
            has(p) {
                if (p === 'length') {
                    return true;
                }
                const numP = Number(p);
                return !Number.isNaN(numP) && numP >= 0 && numP < length;
            },
            get(ctx, address, p) {
                if (p === 'length') {
                    return length;
                }
                const numP = Number(p);
                return type.lazilyAccess(ctx, address + itemSize * numP);
            },
            set(ctx, address, p, newValue) {
                if (p === 'length') {
                    return false;
                }
                const numP = Number(p);
                type.toMemory(ctx, address + itemSize * numP, newValue);
                return true;
            },
        }),
    });
    return arrayType;
}

/**
 * Construct a buffer type. Buffers are returned as static copies instead of dynamic views.
 * @param size Buffer size.
 */
export function makeBuffer(size: number) {
    return mcuType(`_Buffer_(${size})`, size, {
        deserialize: (buffer, offset) => {
            const newBuffer = Buffer.allocUnsafe(size);
            buffer.copy(newBuffer, 0, offset);
            return newBuffer;
        },
        serialize: (buffer, offset, value) => {
            value.copy(buffer, offset);
            if (value.length < size) {
                buffer.fill(0, offset + value.length, offset + size);
            }
            return offset + size;
        },
    });
}

/**
 * Construct a typed array type. TypeArrays are returned as static copies instead of dynamic views.
 * @param ctor Typed array constructor.
 * @param length Array length.
 */
export function makeTypedArray<T extends { buffer: ArrayBuffer; byteLength: number; byteOffset: number }>(
    ctor: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT?: number },
    length: number,
) {
    const byteLength = length * (ctor.BYTES_PER_ELEMENT ?? 1);
    return mcuType(`_${ctor.name}_(${length})`, byteLength, {
        deserialize: (buffer, offset) => {
            const newBuffer = new ArrayBuffer(byteLength);
            buffer.copy(new Uint8Array(newBuffer), 0, offset);
            return new ctor(newBuffer);
        },
        serialize: (buffer, offset, value) => {
            buffer.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset);
            if (value.byteLength < byteLength) {
                buffer.fill(0, offset + value.byteLength, offset + byteLength);
            }
            return offset + byteLength;
        },
    });
}

/**
 * Construct an enum type.
 * @param name Enum type name.
 * @param baseType Base type.
 * @param enumDef Enum definition. Keys are enum names, values are enum values.
 */
export function makeEnum<B extends MCUTypeDef, T extends { [key: string]: ToJsType<B> }>(
    name: string,
    baseType: B,
    enumDef: T,
) {
    const enumDefLookup = new Map<ToJsType<B>, keyof T>();
    for (const [enumKey, enumValue] of Object.entries(enumDef)) {
        enumDefLookup.set(enumValue, enumKey as keyof T);
    }
    return mcuType(name, baseType.size, {
        align: baseType.align,
        symbols: baseType.symbols as B['symbols'],
        deserialize: (buffer, offset, ctx, addr) => {
            const baseValue = deserialize(ctx, baseType, buffer, offset, addr);
            const value = enumDefLookup.get(baseValue);
            if (value === undefined) {
                throw new Error(`Value ${baseValue} cannot converted to enum ${name}`);
            }
            return value;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            if (!Object.hasOwn(enumDef, value)) {
                throw new Error(`${String(value)} is not a valid key for enum ${name}`);
            }
            const baseValue = enumDef[value];
            return serialize(ctx, baseType, baseValue, buffer, offset, addr);
        },
    });
}

/**
 * Construct a flags type.
 * @param name Flags type name.
 * @param baseType Base type.
 * @param flagDef Flags definition. Keys are flag names, values are flag values.
 */
export function makeFlags<B extends MCUTypeDef<number>, T extends { [key: string]: ToJsType<B> }>(
    name: string,
    baseType: B,
    flagDef: T,
) {
    const flagDefEntries = Object.entries(flagDef) as [key: keyof T, flag: ToJsType<B>][];
    const zeroFlagValue = Object.fromEntries(flagDefEntries.map(([k]) => [k, false])) as { [K in keyof T]: boolean };
    return mcuType(name, baseType.size, {
        align: baseType.align,
        symbols: baseType.symbols as B['symbols'],
        deserialize: (buffer, offset, ctx, addr) => {
            const baseValue = deserialize(ctx, baseType, buffer, offset, addr);
            const value = { ...zeroFlagValue };
            for (const [key, flag] of flagDefEntries) {
                value[key] = (baseValue & flag) === flag;
            }
            return value;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            let baseValue = 0;
            for (const [key, flag] of flagDefEntries) {
                if (value[key]) {
                    baseValue |= flag;
                }
            }
            return serialize(ctx, baseType, baseValue, buffer, offset, addr);
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...zeroFlagValue };
            },
            has(p) {
                return p in flagDef;
            },
            get(ctx, address, p) {
                const flag = flagDef[p];
                const baseValue = baseType.fromMemory(ctx, address);
                return (baseValue & flag) === flag;
            },
            set(ctx, address, p, newValue) {
                const flag = flagDef[p];
                let baseValue = baseType.fromMemory(ctx, address);
                if (newValue) {
                    baseValue |= flag;
                } else {
                    baseValue &= ~flag;
                }
                baseType.toMemory(ctx, address, baseValue);
                return true;
            },
        }),
    });
}

export type StructDefToTypeMap<T extends Record<string, MCUTypeDef | [type: MCUTypeDef, offset?: number]>> = {
    [K in keyof T]: T[K] extends MCUTypeDef ? T[K] : T[K] extends [infer U extends MCUTypeDef, number?] ? U : never;
};

/**
 * Construct a struct type.
 * @param name Struct type name.
 * @param structDef Struct definition. Keys are field names, values are field types or `[type, offset]` tuples.
 * @param align Optional alignment. Defaults to the field's own alignment.
 */
export function makeStructure<T extends Record<string, MCUTypeDef | [type: MCUTypeDef, offset?: number]>>(
    name: string,
    structDef: T,
    align?: number,
) {
    type StructDef = StructDefToTypeMap<T>;
    let size = 0;
    const entryMap = new Map<string, { type: MCUTypeDef; offset: number }>();
    const objectTemplate = {} as { [K in keyof T]: ToJsType<StructDef[K]> };
    const symbols = {} as { [K in keyof T]: MCUSymbolDef<StructDef[K]> };
    let maxAlign = align ?? 1;
    let nextOffset = 0;
    for (const [key, def] of Object.entries(structDef)) {
        const type = Array.isArray(def) ? def[0] : def;
        let offset = Array.isArray(def) ? (def[1] ?? 0) : nextOffset;
        const itemAlign = align ?? type.align;
        maxAlign = Math.max(maxAlign, itemAlign);
        offset = alignedCeil(offset, itemAlign);
        entryMap.set(key, { type, offset });
        (objectTemplate as Record<string, unknown>)[key] = undefined;
        (symbols as SymbolDefintions)[key] = { type, address: offset };
        nextOffset = offset + type.size;
        size = Math.max(size, nextOffset);
    }
    size = alignedCeil(size, maxAlign);
    const structType = mcuType(name, size, {
        align: maxAlign,
        symbols,
        deserialize: (buffer, offset, ctx, addr) => {
            const obj = { ...objectTemplate };
            for (const [key, { type, offset: entOffset }] of entryMap.entries()) {
                (obj as Record<string, unknown>)[key] = deserialize(
                    ctx,
                    type,
                    buffer,
                    offset + entOffset,
                    addr !== undefined ? addr + offset : undefined,
                );
            }
            return obj;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            for (const [key, { type, offset: entOffset }] of entryMap.entries()) {
                serialize(
                    ctx,
                    type,
                    value[key],
                    buffer,
                    offset + entOffset,
                    addr !== undefined ? addr + entOffset : undefined,
                );
            }
            return offset + size;
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...objectTemplate };
            },
            has(p) {
                return entryMap.has(p);
            },
            get(ctx, address, p) {
                const { type, offset } = entryMap.get(p)!;
                return type.lazilyAccess(ctx, address + offset);
            },
            set(ctx, address, p, newValue) {
                const { type, offset } = entryMap.get(p)!;
                type.toMemory(ctx, address + offset, newValue);
                return true;
            },
        }),
    });
    return structType;
}

/**
 * Construct a union type.
 * @param name Union type name.
 * @param unionDef Union definition. Keys are member names, values are member types.
 */
export function makeUnion<T extends Record<string, MCUTypeDef>>(name: string, unionDef: T) {
    const def = { ...unionDef };
    const entries = Object.entries(def);
    const objectTemplate = {} as { [K in keyof T]: ToJsType<T[K]> };
    const symbols = {} as { [K in keyof T]: MCUSymbolDef<T[K]> };
    let maxSize = 0;
    let maxAlign = 1;
    for (const [key, def] of entries) {
        maxAlign = Math.max(maxAlign, def.align);
        maxSize = Math.max(maxSize, def.size);
        (objectTemplate as Record<string, unknown>)[key] = undefined;
        (symbols as SymbolDefintions)[key] = { type: def, address: 0 };
    }
    maxSize = alignedCeil(maxSize, maxAlign);
    const unionType = mcuType(name, maxSize, {
        align: maxAlign,
        symbols,
        deserialize: (buffer, offset, ctx, addr) => {
            const obj = { ...objectTemplate };
            for (const [key, def] of entries) {
                (obj as Record<string, unknown>)[key] = deserialize(ctx, def, buffer, offset, addr);
            }
            return obj;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            for (const [key, def] of entries) {
                serialize(ctx, def, value[key], buffer, offset, addr);
            }
            return offset + maxSize;
        },
        lazilyAccess: createLazilyProxyAccesser({
            baseObjectFactory() {
                return { ...objectTemplate };
            },
            has(p) {
                return Object.hasOwn(def, p);
            },
            get(ctx, address, p) {
                return def[p].lazilyAccess(ctx, address);
            },
            set(ctx, address, p, newValue) {
                def[p].toMemory(ctx, address, newValue);
                return true;
            },
        }),
    });
    return unionType;
}

/**
 * Input reference type.
 */
export type InRef<T> = T | null | undefined;

/**
 * Construct an input reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeInReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `${type.name}*`;
    return mcuType<InRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: (buffer, offset, ctx) => {
            const address = pointerType.fromRegister(ctx, buffer, offset);
            if (address === 0) {
                return null;
            }
            // prevent circular reference
            return type.lazilyAccess(ctx, address);
        },
        toMemory: (ctx, addr, value, buffer, offset) => {
            if (value === undefined || value === null) {
                return pointerType.toMemory(ctx, addr, 0, buffer, offset);
            }
            if (typeof value === 'object' && isLazilyAccessProxy(value)) {
                return pointerType.toMemory(ctx, addr, value[MemoryAddress], buffer, offset);
            }
            throw new Error(`Ambiguous operation. Use pointer type instead.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (value === undefined || value === null) {
                return pointerType.toRegister(ctx, 0, buffer, offset);
            }
            if (isLazilyAccessProxy(value)) {
                return pointerType.toRegister(ctx, value[MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            type.toMemory(ctx, alloc.address, value);
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Output reference type.
 */
export type OutRef<T> = [T?];

/**
 * Construct an output reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeOutReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Out_ ${type.name}*`;
    return mcuType<OutRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: () => {
            throw new Error(`Reference type ${name} can only be used in function parameters.`);
        },
        toMemory: () => {
            throw new Error(`Cannot change the value of reference type ${name}.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (isLazilyAccessProxy(value[0])) {
                return pointerType.toRegister(ctx, value[0][MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            alloc.finalize = () => {
                value[0] = type.fromMemory(ctx, alloc.address);
            };
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Input/output reference type.
 */
export type InoutRef<T> = [T];

/**
 * Construct an input/output reference type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Referent type.
 */
export function makeInoutReference<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Inout_ ${type.name}*`;
    return mcuType<InoutRef<ToJsType<T>>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: () => {
            throw new Error(`Reference type ${name} can only be used in function parameters.`);
        },
        toMemory: () => {
            throw new Error(`Cannot change the value of reference type ${name}.`);
        },
        toRegister: (ctx, value, buffer, offset) => {
            if (isLazilyAccessProxy(value[0])) {
                return pointerType.toRegister(ctx, value[0][MemoryAddress], buffer, offset);
            }
            const alloc = ctx.allocator.allocateAuto(ctx, type.size, type.align);
            if (!alloc) {
                throw new Error(`Cannot allocate ${type.size} byte(s) from stack.`);
            }
            type.toMemory(ctx, alloc.address, value[0]);
            alloc.finalize = () => {
                value[0] = type.fromMemory(ctx, alloc.address);
            };
            return pointerType.toRegister(ctx, alloc.address, buffer, offset);
        },
    });
}

/**
 * Reference type constructor.
 */
export type ReferenceType = {
    <T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    in<T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    out<T extends MCUTypeDef>(type: T): MCUTypeDef<OutRef<ToJsType<T>>>;
    inout<T extends MCUTypeDef>(type: T): MCUTypeDef<InoutRef<ToJsType<T>>>;
};

/**
 * Construct a reference type constructor.
 * @param pointerType Underlying primitive type of the pointer.
 */
export function makeReferenceType(pointerType: MCUTypeDef<number>) {
    const ref: ReferenceType = <T extends MCUTypeDef>(type: T) => makeInReference(pointerType, type);
    ref.in = ref;
    ref.out = <T extends MCUTypeDef>(type: T) => makeOutReference(pointerType, type);
    ref.inout = <T extends MCUTypeDef>(type: T) => makeInoutReference(pointerType, type);
    return ref;
}

/**
 * Pointer type.
 */
export interface MCUPointer<T extends MCUTypeDef = MCUTypeDef> {
    address: number;
    value: ToJsType<T>;
    readonly symbol: MCUSymbol<T>;
}

/**
 * Construct a pointer type.
 * @param pointerType Underlying primitive type of the pointer.
 * @param type Target type the pointer points to.
 */
export function makePointer<T extends MCUTypeDef>(pointerType: MCUTypeDef<number>, type: T) {
    const name = `_Pointer_ ${type.name}*`;
    return mcuType<MCUPointer<T>>(name, pointerType.size, {
        align: pointerType.align,
        deserialize: (buffer, offset, ctx, addr) => {
            const address = deserialize(ctx, pointerType, buffer, offset, addr);
            const ptr = {
                address,
                symbol: createSymbol(ctx, address, type),
            } as MCUPointer<T>;
            // prevent circular reference
            Object.defineProperty(ptr, 'value', {
                configurable: true,
                enumerable: true,
                get: () => type.lazilyAccess(ctx, address),
                set: (value) => type.toMemory(ctx, address, value),
            });
            return ptr;
        },
        serialize: (buffer, offset, value, ctx, addr) => {
            return serialize(ctx, pointerType, value.address, buffer, offset, addr);
        },
        lazilyAccess: createLazilyAccessor((ctx, addr) => {
            const getAddress = () => pointerType.fromMemory(ctx, addr);
            const ptr = {} as MCUPointer<T>;
            Object.defineProperty(ptr, 'address', {
                configurable: true,
                enumerable: true,
                get: getAddress,
                set: (value) => pointerType.toMemory(ctx, addr, value),
            });
            Object.defineProperty(ptr, 'value', {
                configurable: true,
                enumerable: true,
                get: () => type.lazilyAccess(ctx, getAddress()),
                set: (value) => type.toMemory(ctx, getAddress(), value),
            });
            Object.defineProperty(ptr, 'symbol', {
                configurable: true,
                enumerable: true,
                get: () => createSymbol(ctx, getAddress(), type),
            });
            return ptr;
        }),
    });
}

/**
 * Construct a pointer type constructor.
 * @param pointerType Underlying primitive type of the pointer.
 */
export function makePointerType(pointerType: MCUTypeDef<number>) {
    return <T extends MCUTypeDef>(type: T) => makePointer(pointerType, type);
}

/**
 * A typed view over a region of MCU memory with bounds checking.
 */
export class MCUSpan {
    #type: MCUTypeDef<MCUSpan> | undefined;
    #symbol: MCUSymbol<MCUTypeDef<MCUSpan>> | undefined;
    readonly context: MCUContext;
    readonly address: number;
    readonly size?: number;

    constructor(ctx: MCUContext, addr: number, size?: number, type?: MCUTypeDef<MCUSpan>) {
        this.context = ctx;
        this.#type = type;
        this.address = addr;
        this.size = size;
    }

    get [NativeType]() {
        if (!this.#type) {
            this.#type = makeSpan(this.size);
        }
        return this.#type;
    }

    get [MemoryAddress]() {
        return this.address;
    }

    get symbol() {
        if (!this.#symbol) {
            this.#symbol = createSymbol(this.context, this.address, this[NativeType]);
        }
        return this.#symbol;
    }

    protected checkValidIndex(value: number, allowEqual?: boolean) {
        if (value < 0 || Number.isNaN(value) || !Number.isSafeInteger(value)) {
            return false;
        }
        if (this.size !== undefined) {
            if (allowEqual) {
                if (value > this.size) {
                    return false;
                }
            } else {
                if (value >= this.size) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Get a sub-region of the memory region.
     * @param start Start position.
     * @param end End position. Defaults to the end of the region.
     */
    slice(start: number, end?: number) {
        if (!this.checkValidIndex(start, true)) {
            throw new Error('Invalid start index');
        }
        if (end !== undefined) {
            if (!this.checkValidIndex(end, true)) {
                throw new Error('Invalid end index');
            }
            if (end < start) {
                throw new Error('Invalid range');
            }
        }
        return new MCUSpan(this.context, this.address + start, end ? end - start : this.size);
    }

    /**
     * Cast the memory region to a dynamic view of the specified type.
     * @param type Target type.
     * @param offset Offset.
     */
    cast<T>(type: MCUTypeDef<T>, offset: number = 0): T {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return type.lazilyAccess(this.context, this.address + offset);
    }

    /**
     * Cast the memory region to a function of the specified type.
     * @param def Function definition.
     * @param offset Offset.
     */
    bind<F extends (...args: never[]) => unknown>(def: MCUFunctionDef<F>, offset: number = 0): ToAsyncFunction<F> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        return def(this.context, this.address + offset, '(anonymous)');
    }

    /**
     * Read and deserialize data from the memory region.
     * @param type Data type.
     * @param offset Offset.
     */
    read<T extends MCUTypeDef>(type: T, offset: number = 0): ToJsType<T> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return type.fromMemory(this.context, this.address + offset);
    }

    /**
     * Serialize and write data to the memory region.
     * @param type Data type.
     * @param value Data value.
     * @param offset Offset.
     */
    write<T extends MCUTypeDef>(type: T, value: ToJsType<T>, offset: number = 0) {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        type.toMemory(this.context, this.address + offset, value);
    }

    /**
     * Create a data reference within the memory region.
     * @param type Data type.
     * @param offset Offset.
     */
    referenceOf<T extends MCUTypeDef>(type: T, offset: number = 0): MCUReference<T> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        if (this.size !== undefined) {
            const endOffset = offset + type.size;
            if (!this.checkValidIndex(endOffset, true)) {
                throw new Error('Insufficient space for type');
            }
        }
        return createReference(this.context, this.address + offset, type);
    }

    /**
     * Copy data from the memory region to a target memory region.
     * @param target Target memory region.
     * @param targetStart Start position in target. Defaults to 0.
     * @param sourceStart Start position in source. Defaults to 0.
     * @param sourceEnd End position in source. Defaults to the end of the region.
     */
    copyTo(target: MCUSpan, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
        if (targetStart !== undefined && !target.checkValidIndex(targetStart, true)) {
            throw new Error('Invalid target start index');
        }
        if (sourceStart !== undefined && !this.checkValidIndex(sourceStart, true)) {
            throw new Error('Invalid source start index');
        }
        if (sourceEnd !== undefined && !this.checkValidIndex(sourceEnd, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const sourceSize = this.size !== undefined ? this.size - srcStart : Infinity;
        const targetSize = target.size !== undefined ? target.size - tgtStart : Infinity;
        const sizeLimit = Math.min(sourceSize, targetSize);
        let size = sizeLimit;
        if (sourceEnd !== undefined) {
            size = sourceEnd - srcStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (!Number.isFinite(size)) {
            throw new Error(
                'Size is required for copying between spans of unknown length. Please specify the size explicitly.',
            );
        }
        if (size <= 0) return;
        const buffer = Buffer.allocUnsafe(size);
        this.context.link.readMemory(this.address + srcStart, buffer);
        target.context.link.writeMemory(target.address + tgtStart, buffer);
    }

    /**
     * Read data from the memory region and returns it as a new Buffer.
     * @param start Start position. Defaults to 0.
     * @param end End position. Defaults to the end of the region.
     * @returns A buffer containing the copied data.
     */
    readBuffer(start?: number, end?: number) {
        if (start !== undefined && !this.checkValidIndex(start)) {
            throw new Error('Invalid source start index');
        }
        if (end !== undefined && !this.checkValidIndex(end, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = start ?? 0;
        const size = end !== undefined ? end - srcStart : this.size !== undefined ? this.size - srcStart : Infinity;
        if (!Number.isFinite(size)) {
            throw new Error(
                'Size is required for reading spans of unknown length. Please specify the size explicitly.',
            );
        }
        const buffer = Buffer.allocUnsafe(size);
        this.context.link.readMemory(this.address + srcStart, buffer);
        return buffer;
    }

    /**
     * Copy data from the memory region to a given target buffer.
     * @param target Target buffer.
     * @param targetStart Start position in target buffer. Defaults to 0.
     * @param sourceStart Start position in source memory. Defaults to 0.
     * @param sourceEnd End position in source memory. Defaults to the end of the region.
     */
    readIntoBuffer(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number) {
        if (targetStart !== undefined && targetStart > target.length) {
            throw new Error('Invalid target start index');
        }
        if (sourceStart !== undefined && !this.checkValidIndex(sourceStart)) {
            throw new Error('Invalid source start index');
        }
        if (sourceEnd !== undefined && !this.checkValidIndex(sourceEnd, true)) {
            throw new Error('Invalid source end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const sourceSize = this.size !== undefined ? this.size - srcStart : Infinity;
        const targetSize = target.length - tgtStart;
        const sizeLimit = Math.min(sourceSize, targetSize);
        let size = sizeLimit;
        if (sourceEnd !== undefined) {
            size = sourceEnd - srcStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (size <= 0) return;
        this.context.link.readMemory(this.address + srcStart, target.subarray(tgtStart, tgtStart + size));
        return target;
    }

    /**
     * Write data from a source buffer to the memory region.
     * @param source Source buffer.
     * @param sourceStart Start position in source buffer. Defaults to 0.
     * @param targetStart Start position in target memory. Defaults to 0.
     * @param targetEnd End position in target memory. Defaults to the end of the region.
     */
    writeBuffer(source: Buffer, sourceStart?: number, targetStart?: number, targetEnd?: number) {
        if (sourceStart !== undefined && sourceStart > source.length) {
            throw new Error('Invalid source start index');
        }
        if (targetStart !== undefined && !this.checkValidIndex(targetStart, true)) {
            throw new Error('Invalid target start index');
        }
        if (targetEnd !== undefined && !this.checkValidIndex(targetEnd, true)) {
            throw new Error('Invalid target end index');
        }
        const srcStart = sourceStart ?? 0;
        const tgtStart = targetStart ?? 0;
        const targetSize = this.size !== undefined ? this.size - tgtStart : Infinity;
        const sourceSize = source.length - srcStart;
        const sizeLimit = Math.min(targetSize, sourceSize);
        let size = sizeLimit;
        if (targetEnd !== undefined) {
            size = targetEnd - tgtStart;
            if (size > sizeLimit) {
                throw new Error(`Size is too large: size should not exceed ${sizeLimit}, got ${size}`);
            }
            if (size < 0) {
                throw new Error(`Invalid range`);
            }
        }
        if (size <= 0) return;
        this.context.link.writeMemory(this.address + tgtStart, source.subarray(srcStart, srcStart + size));
    }
}

let infiniteSpanType: MCUTypeDef<MCUSpan> | undefined;
/**
 * Construct a memory region type.
 * @param size Region size. Omit for infinite size.
 */
export function makeSpan(size?: number) {
    if (size !== undefined) {
        const type = mcuType(`Span[${size}]`, size, {
            fromMemory: (ctx, addr): MCUSpan => {
                return new MCUSpan(ctx, addr, size, type);
            },
            toMemory: () => {
                throw new Error(`Invalid operation, use MCUSpan.copyTo instead.`);
            },
            lazilyAccess: createLazilyAccessor(),
        });
        return type;
    } else {
        if (!infiniteSpanType) {
            infiniteSpanType = mcuType('Span[*]', 0, {
                fromMemory: (ctx, addr) => {
                    return new MCUSpan(ctx, addr, undefined, infiniteSpanType);
                },
                toMemory: () => {
                    throw new Error(`Invalid operation, use MCUSpan.copyTo instead.`);
                },
                lazilyAccess: createLazilyAccessor(),
            });
        }
        return infiniteSpanType;
    }
}

/**
 * Convert a function type to an async function type.
 */
export type ToAsyncFunction<F extends (...args: never[]) => unknown> = (
    ...args: Parameters<F>
) => Promise<Awaited<ReturnType<F>>>;

/**
 * MCUFunctionDef interface tag. Stores the corresponding JavaScript function signature.
 */
export declare const signatureTag: unique symbol;

/**
 * Function definition. Describes parameter and return value types.
 */
export type MCUFunctionDef<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> = {
    [signatureTag]: F;
    (ctx: MCUContext, address: number, name: string): ToAsyncFunction<F>;
};

/**
 * JavaScript representation of a function definition.
 */
export type ToJsFunction<T extends MCUFunctionDef> = ToAsyncFunction<T[typeof signatureTag]>;

/**
 * JavaScript representation of a function or type definition.
 */
export type ToJs<T extends MCUTypeDef | MCUFunctionDef> = T extends MCUTypeDef
    ? ToJsType<T>
    : T extends MCUFunctionDef
      ? ToJsFunction<T>
      : never;

export type WrapParametersToType<T extends unknown[]> = {
    [K in keyof T]: MCUTypeDef<T[K]>;
};
export type InferParametersFromType<T extends MCUTypeDef[]> = {
    [K in keyof T]: ToJsType<T[K]>;
};

/**
 * Function factory.
 */
export type CallFactory = {
    <R extends MCUTypeDef, P extends MCUTypeDef[]>(
        returnType: R,
        ...argumentTypes: P
    ): MCUFunctionDef<(...args: InferParametersFromType<P>) => ToJsType<R>>;
    <F extends (...args: never[]) => unknown>(
        returnType: MCUTypeDef<ReturnType<F>>,
        ...argumentTypes: WrapParametersToType<Parameters<F>>
    ): MCUFunctionDef<F>;
};

/**
 * See {@link makeCallConvention}.
 */
export type CallFactoryCleanUp<F extends (...args: never[]) => unknown> = (
    error?: null | Error,
) => Promisable<ReturnType<F>>;
/**
 * See {@link makeCallConvention}.
 */
export type CallFactoryPrepare<F extends (...args: never[]) => unknown> = (
    ...args: Parameters<F>
) => Promisable<CallFactoryCleanUp<F>>;
/**
 * See {@link makeCallConvention}.
 */
export type CallFactoryInitialize = <F extends (...args: never[]) => unknown>(
    ctx: MCUContext,
    address: number,
    name: string,
    returnType: MCUTypeDef<ReturnType<F>>,
    ...argumentTypes: WrapParametersToType<Parameters<F>>
) => CallFactoryPrepare<F>;

/**
 * Define a calling convention for function invocation.
 *
 * The lifecycle of a call proceeds in three stages:
 * 1. {@link CallFactoryInitialize} initializes stack layout. Called when defining a function.
 * 2. {@link CallFactoryPrepare} fills registers and stack with arguments. Called when invoking a function.
 * 3. {@link CallFactoryCleanUp} restores registers and stack, retrieves return value. Called after completion or error.
 *
 * @param initialize `CallFactoryInitialize` function.
 * @returns Function factory.
 */
export function makeCallConvention(initialize: CallFactoryInitialize): CallFactory {
    return <F extends (...args: never[]) => unknown>(
        returnType: MCUTypeDef<ReturnType<F>>,
        ...argumentTypes: WrapParametersToType<Parameters<F>>
    ) => {
        return ((ctx, address, name) => {
            const { link } = ctx;
            const prepare = initialize<F>(ctx, address, name, returnType, ...argumentTypes);
            const func = async (...args: Parameters<F>) => {
                let running = false;
                if (!link.isHalted()) {
                    link.halt();
                    running = true;
                }
                const cleanup = await prepare(...args);
                link.resume();

                if (returnType === neverType) {
                    return new Promise<never>(() => {});
                }

                const maxTime = Date.now() + ctx.callTimeout;
                while (!link.isHalted()) {
                    if (Number.isFinite(maxTime) && Date.now() > maxTime) {
                        link.halt();
                        const timeoutError = new Error(`Function execution exceeded timeout of ${ctx.callTimeout}ms.`);
                        await cleanup(timeoutError);
                        throw timeoutError;
                    }
                    await setImmediate();
                }

                const returnValue = await cleanup(null);
                if (running) {
                    link.resume();
                }
                return returnValue;
            };
            Object.defineProperty(func, 'name', {
                configurable: true,
                value: name,
            });
            return func;
        }) as MCUFunctionDef<F>;
    };
}

/**
 * Create a composite call convention.
 *
 * Used when the return type is a composite type larger than 4 bytes.
 * The function modifies memory pointed to by the first argument to return the value.
 *
 * @param factory Original function factory.
 * @param outRefType Output reference type.
 * @returns Function factory.
 */
export function makeCompositeCall(
    factory: CallFactory,
    outRefType: <T extends MCUTypeDef>(type: T) => MCUTypeDef<OutRef<ToJsType<T>>>,
): CallFactory {
    return <F extends (...args: never[]) => unknown>(
        returnType: MCUTypeDef<ReturnType<F>>,
        ...argumentTypes: WrapParametersToType<Parameters<F>>
    ) => {
        const funcDef = factory(voidType, outRefType(returnType), ...argumentTypes);
        return ((ctx, address, name) => {
            const func = funcDef(ctx, address, name) as unknown as (
                out: OutRef<ReturnType<F>>,
                ...args: Parameters<F>
            ) => Promise<void>;
            const wrapped = async (...args: Parameters<F>) => {
                const outRef: OutRef<ReturnType<F>> = [];
                await func(outRef, ...args);
                return outRef[0]!;
            };
            Object.defineProperty(wrapped, 'name', {
                configurable: true,
                value: name,
            });
            return wrapped;
        }) as MCUFunctionDef<F>;
    };
}

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

/**
 * Heap allocation handle. Requires manual `free()` or `using` syntax.
 */
export interface MCUAllocation extends Disposable {
    /**
     * Memory address.
     */
    readonly address: number;
    /**
     * Memory size.
     */
    readonly size: number;
    /**
     * Memory alignment.
     */
    readonly align?: number;
    /**
     * Free the memory.
     */
    free(): void;
}

/**
 * Stack allocation handle. Automatically freed when function returns.
 */
export interface MCUAutoAllocation {
    /**
     * Memory address.
     */
    readonly address: number;
    /**
     * Memory size.
     */
    readonly size: number;
    /**
     * Memory alignment.
     */
    readonly align?: number;
    /**
     * Finalizer. Called automatically when freed.
     */
    finalize?: () => void;
}

export interface MCUFinalizer {
    finalize(): void;
}

/**
 * Memory allocator.
 */
export interface MCUAllocator {
    /**
     * Allocate memory from the stack.
     *
     * @param ctx Call context.
     * @param size Allocation size.
     * @param align Alignment.
     * @returns A new stack allocation handle, or `null` if allocation failed.
     */
    allocateAuto(ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null;

    /**
     * Allocate memory from the heap. Returns `null` without heap control or insufficient space.
     *
     * @param ctx Call context.
     * @param size Allocation size.
     * @param align Alignment.
     * @returns Heap allocation handle.
     */
    allocate(ctx: MCUContext, size: number, align?: number): MCUAllocation | null;

    /**
     * Grant control over the stack memory via a user-supplied pointer modification method.
     *
     * This method returns a **Reclaimer** function. The lifecycle proceeds in two stages:
     * 1. **Revoke:** Calling the Reclaimer revokes stack control and returns a **Finalizer**.
     *    - After this point, further stack allocations will fail.
     *    - Existing allocations remain valid.
     * 2. **Finalize:** Calling the Finalizer frees all stack-allocated memory.
     *
     * @param commit - A callback function used to modify the stack pointer.
     *   - To **allocate**: Pass `size` and `align`. Returns the starting address, or `null` if allocation failed.
     *   - To **inspect**: Omit arguments to retrieve the current stack pointer.
     * @returns A Reclaimer function that, when invoked, returns the Finalizer.
     */
    stackAccess(ctx: MCUContext, commit: (size?: number, align?: number) => number | null): () => MCUFinalizer;

    /**
     * Grant heap control. Heap control cannot be reclaimed.
     *
     * @param ctx Call context.
     * @param heapBase Heap starting address.
     * @param heapLimit Heap ending address. Defaults to infinity.
     */
    heapAccess(ctx: MCUContext, heapBase: number, heapLimit?: number): void;
}

export class DefaultAllocator implements MCUAllocator {
    protected allocations = new Set<MCUAllocation>();
    protected freeBlocks: [start: number, end: number][] = [];
    protected autoAllocations = new Set<MCUAutoAllocation>();
    protected commitStack?: (size?: number, align?: number) => number | null;
    allocateAuto(_ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null {
        const commitStack = this.commitStack;
        if (!commitStack) {
            return null;
        }
        const address = commitStack(size, align);
        if (address === null) {
            return null;
        }
        const alloc = { address, size, align };
        this.autoAllocations.add(alloc);
        return alloc;
    }
    allocate(_ctx: MCUContext, size: number, align?: number): MCUAllocation | null {
        if (this.freeBlocks.length === 0) {
            return null;
        }
        for (let i = 0; i < this.freeBlocks.length; i++) {
            const freeBlock = this.freeBlocks[i];
            const address = align !== undefined ? alignedCeil(freeBlock[0], align) : freeBlock[0];
            const endAddr = address + size;
            if (freeBlock[1] >= endAddr) {
                if (address > freeBlock[0]) {
                    this.freeBlocks.splice(i, 0, [freeBlock[0], address]);
                    i += 1;
                }
                freeBlock[0] = endAddr;
                if (this.freeBlocks.length > 1 && freeBlock[0] >= freeBlock[1]) {
                    this.freeBlocks.splice(i, 1);
                }
                const free = () => this.free(alloc, address, endAddr);
                const alloc = { address, size, align, free, [Symbol.dispose]: free };
                this.allocations.add(alloc);
                return alloc;
            }
        }
        return null;
    }
    protected free(alloc: MCUAllocation, address: number, endAddr: number) {
        if (!this.allocations.has(alloc)) {
            throw new Error(`Allocation is already freed.`);
        }
        this.allocations.delete(alloc);
        let inserted = false;
        for (let i = 0; i < this.freeBlocks.length; i++) {
            const freeBlock = this.freeBlocks[i];
            if (endAddr <= freeBlock[0]) {
                this.freeBlocks.splice(i, 0, [address, endAddr]);
                inserted = true;
            }
        }
        if (!inserted) {
            this.freeBlocks.push([address, endAddr]);
        }
        for (let i = 1; i < this.freeBlocks.length; i++) {
            const prev = this.freeBlocks[i - 1];
            const next = this.freeBlocks[i];
            if (prev[1] === next[0]) {
                prev[1] = next[1];
                this.freeBlocks.splice(i, 1);
                i -= 1;
            }
            if (prev[1] > next[0]) {
                throw new Error('Overlapping free blocks');
            }
        }
    }
    stackAccess(_ctx: MCUContext, commit: (size?: number, align?: number) => number | null): () => MCUFinalizer {
        if (this.commitStack) {
            throw new Error(`stackAccess is called twice.`);
        }
        this.commitStack = commit;
        return () => {
            this.commitStack = undefined;
            const allocs = [...this.autoAllocations];
            this.autoAllocations.clear();
            return {
                finalize() {
                    for (const alloc of allocs) {
                        alloc.finalize?.();
                    }
                },
            };
        };
    }
    heapAccess(_ctx: MCUContext, heapBase: number, heapLimit?: number): void {
        this.freeBlocks.push([heapBase, heapLimit ?? Infinity]);
    }
}

function resolveAddress(addr: string | number, symbolAddresses: SymbolAddresses, ...defaultSymbols: string[]): number;
function resolveAddress(
    addr: string | number | undefined,
    symbolAddresses: SymbolAddresses,
    ...defaultSymbols: string[]
): number | undefined;
function resolveAddress(
    addr: string | number | undefined,
    symbolAddresses: SymbolAddresses,
    ...defaultSymbols: string[]
) {
    let resolved: number | undefined;
    if (typeof addr === 'number') {
        resolved = addr;
    } else if (typeof addr === 'string') {
        resolved = symbolAddresses[addr];
        if (resolved === undefined) {
            throw new Error(`Symbol ${addr} not found. Do you add it or mark it as __attribute__((used))?`);
        }
    } else {
        for (const defaultSymbol of defaultSymbols) {
            resolved = symbolAddresses[defaultSymbol];
            if (resolved !== undefined) {
                break;
            }
        }
    }
    return resolved;
}

function offsetAddressMap(symbolAddresses: SymbolAddresses, memoryOffset: number) {
    const newSymbolAddresses: SymbolAddresses = {};
    for (const [k, v] of Object.entries(symbolAddresses)) {
        newSymbolAddresses[k] = v + memoryOffset;
    }
    return newSymbolAddresses;
}

/**
 * Formats an address as a symbol name with offset.
 * @param symbolAddresses Symbol table.
 * @param address Address.
 * @param searchUpperBound Search range upper bound.
 * @param searchLowerBound Search range lower bound.
 */
export function addressToString(
    symbolAddresses: SymbolAddresses,
    address: number,
    searchUpperBound = 0xfff,
    searchLowerBound = 0,
) {
    let bestName: string | undefined;
    let bestOffset = Infinity;
    for (const [symbolName, symbolAddress] of Object.entries(symbolAddresses)) {
        const offset = address - symbolAddress;
        if (offset >= searchLowerBound && offset <= searchUpperBound && Math.abs(offset) < bestOffset) {
            bestName = symbolName;
            bestOffset = offset;
        }
    }
    if (bestName === undefined) {
        return `0x${address.toString(16)}`;
    }
    return `0x${address.toString(16)} (${bestName}+0x${bestOffset.toString(16)})`;
}

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

/**
 * Direct manipulation interfaces to specific memory addresses.
 * They provide immediate read/write access and can be assigned to pointer-type variables.
 */
export interface MCUReference<T extends MCUTypeDef> {
    readonly [NativeType]: T;
    readonly [MemoryAddress]: number;
    readonly address: number;
    value: ToJsType<T>;
    readonly symbol: MCUSymbol<T>;
}

export function createReference<T extends MCUTypeDef, B = object>(
    ctx: MCUContext,
    address: number,
    type: T,
    baseObject?: B,
) {
    const ref = (baseObject ?? {}) as B & MCUReference<typeof type>;
    Object.defineProperty(ref, 'address', {
        configurable: true,
        enumerable: true,
        value: address,
    });
    Object.defineProperty(ref, 'value', {
        configurable: true,
        enumerable: true,
        ...createVariable(ctx, address, type),
    });
    Object.defineProperty(ref, 'symbol', {
        configurable: true,
        enumerable: true,
        value: createSymbol(ctx, address, type),
    });
    Object.defineProperty(ref, NativeType, {
        configurable: false,
        enumerable: false,
        value: type,
    });
    Object.defineProperty(ref, MemoryAddress, {
        configurable: false,
        enumerable: false,
        value: address,
    });
    return ref;
}

/**
 * Represents a symbolic or numeric address.
 *
 * A value that acts as a memory reference, either as a symbol name or a raw numeric address.
 */
export type AddressLike<Definitions extends Record<string, unknown> = EmptyKeyObject> = LiteralUnion<
    keyof Definitions,
    string | number
>;

/**
 * Represents an addressable entity.
 *
 * An object possessing a valid memory address that can be retrieved via specific accessors or context methods.
 */
export type Addressable = MCUSymbol | MCUReference<MCUTypeDef> | MCUSpan | LazilyAccessObject | Record<never, never>;

/**
 * Represents a typed value.
 *
 * An object that holds a value with a specific type definition, enabling type-safe operations.
 */
export type TypedValue<T extends MCUTypeDef> = MCUSymbol<T> | MCUReference<T>;

/**
 * Represents a typed addressable entity.
 *
 * An intersection of {@link TypedValue} and {@link Addressable}. It combines a specific type definition with a retrievable memory address.
 */
export type TypedAddressable<T extends MCUTypeDef> = MCUSymbol<T> | MCUReference<T>;

export type AppendDefinition<Definitions extends Record<string, unknown>> = {
    [name: string]: MCUTypeDef | MCUFunctionDef;
} & { [K in keyof MCUCall<Definitions>]?: never };

/**
 * MCU call instance.
 */
export type MCUCall<
    Definitions extends Record<string, unknown> = EmptyKeyObject,
    Symbols extends Record<string, unknown> = EmptyKeyObject,
> = {
    /**
     * Define a variable or function.
     *
     * Searches the symbol table for the address, then exposes the symbol on the instance.
     *
     * @param def Symbol name and type pairs.
     */
    define<T extends AppendDefinition<Definitions>>(
        def: T,
    ): MCUCall<Definitions & { [k in keyof T]: ToJs<T[k]> }, Symbols & { [k in keyof T]: ToSymbol<T[k]> }>;

    /**
     * Resolve a memory address.
     *
     * Converts various address representations into a raw numeric pointer.
     *
     * @param symbol The target to resolve (address, symbol, or {@link Addressable}).
     */
    addressOf(symbol: AddressLike<Definitions> | Addressable): number;

    /**
     * Retrieve the type definition.
     *
     * Extracts the specific type metadata associated with a typed value.
     *
     * @param symbol The {@link TypedValue} to inspect.
     */
    typeOf<T extends MCUTypeDef>(symbol: TypedValue<T>): T;

    /**
     * Retrieve the type definition size.
     *
     * A convenience accessor that returns the `size` property of the type definition associated with the symbol.
     *
     * @param symbol Typed value.
     */
    sizeOf<T extends MCUTypeDef>(symbol: TypedValue<T>): T['size'];

    /**
     * Allocate heap memory.
     *
     * @param type Type definition.
     */
    'new'<T extends MCUTypeDef>(type: T): MCUAllocation & MCUReference<T>;

    /**
     * Reinterprets the data at a specific address as a dynamic view.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param type The target type definition to cast to.
     */
    cast<T>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: MCUTypeDef<T>): T;

    /**
     * Reinterprets the data at a specific address as a function, allowing the raw code at that location to be invoked as a callable function.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param def The target function definition to bind to.
     */
    bind<F extends (...args: never[]) => unknown>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        def: MCUFunctionDef<F>,
    ): ToAsyncFunction<F>;

    /**
     * Retrieves the value at a specific address.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param type The type definition to read the data.
     */
    read<T extends MCUTypeDef>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: T): ToJsType<T>;

    /**
     * Assigns a JavaScript value to a specific address.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param type The type definition to write the data.
     * @param value The JavaScript value to write.
     */
    write<T extends MCUTypeDef>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        type: T,
        value: ToJsType<T>,
    ): void;

    /**
     * Generates a symbol instance associating a specific address with a type definition.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param type The type definition to associate (optional if inferred from input).
     */
    symbolOf<T extends MCUTypeDef>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: T): MCUSymbol<T>;
    symbolOf<T extends MCUTypeDef>(symbolOrAddress: TypedAddressable<T>, type?: T): MCUSymbol<T>;

    /**
     * Generates a reference instance pointing to a specific address with an associated type definition.
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param type The type definition to associate (optional if inferred from input).
     */
    referenceOf<T extends MCUTypeDef>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        type: T,
    ): MCUReference<T>;
    referenceOf<T extends MCUTypeDef>(symbolOrAddress: TypedAddressable<T>, type?: T): MCUReference<T>;

    /**
     * Create a {@link MCUSpan} starting at the given address.
     *
     * @param symbolOrAddress The starting location (address, symbol, or {@link Addressable}).
     * @param size The size of the region in bytes. If omitted, defaults to the size of the symbol's type or infinite.
     */
    spanOf(symbolOrAddress: AddressLike<Definitions> | Addressable, size?: number): MCUSpan;

    /**
     * Converts a dynamic view into a plain JavaScript object.
     *
     * Unlike the live view, modifications to the returned object do not affect the underlying MCU memory.
     * @param value Dynamic view.
     */
    snapshot<T>(value: T): T;

    /**
     * Wraps a value in a reference container.
     *
     * @param value Reference object.
     */
    ref<T>(value: T): InoutRef<T>;

    /**
     * Creates an empty reference container.
     */
    ref<T>(): OutRef<T>;

    /**
     * Formats a memory address as a human-readable string containing the nearest symbol name and the offset (e.g., `SymbolName + 0x10`).
     *
     * @param symbolOrAddress The target location (address, symbol, or {@link Addressable}).
     * @param searchUpperBound The upper bound of the search range.
     * @param searchLowerBound The lower bound of the search range.
     */
    locate(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        searchUpperBound?: number,
        searchLowerBound?: number,
    ): string;

    /**
     * MCU call context.
     */
    context: MCUContext;

    /**
     * Symbol table.
     */
    symbols: Symbols;

    /**
     * List of symbol names.
     */
    symbolNames: string[];
} & {
    [v in keyof Definitions]: Definitions[v];
};

export interface MCUCallOptions {
    /**
     * Base memory offset.
     *
     * An offset value added to all symbol addresses during lookup, allowing for adjustments to the memory map.
     */
    memoryOffset?: number;

    /**
     * Breakpoint location.
     *
     * The address or symbol where the MCU should halt execution. Defaults to `BKPT_FUNCTION`.
     *
     * If the default is not found, the factory injects breakpoint code onto the stack and restores it upon return. You must specify this manually if the MCU does not support stack execution.
     */
    breakpoint?: number | string;

    /**
     * Heap base address.
     *
     * The starting address or symbol for the heap memory region. Defaults to `HEAP_BASE`.
     */
    heap?: number | string;

    /**
     * Heap limit address.
     *
     * The ending address or symbol for the heap memory region. Defaults to `HEAP_LIMIT`.
     *
     * Note: `heapSize` takes precedence over this option if both are specified.
     */
    heapLimit?: number | string;

    /**
     * Heap memory size.
     *
     * The total size of the heap region. Defaults to `Infinity`.
     *
     * Note: This option takes precedence over `heapLimit`.
     */
    heapSize?: number;

    /**
     * Custom memory allocator.
     *
     * A custom implementation for memory management. While you can implement the interface from scratch,
     * extending {@link DefaultAllocator} is recommended for standard behavior.
     */
    allocator?: MCUAllocator;

    /**
     * Execution timeout.
     *
     * The maximum time in milliseconds allowed for a function call. An error is thrown if execution exceeds this limit.
     *
     * Defaults to `Infinity`.
     */
    callTimeout?: number;
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
    const resultProto: MCUCall = {
        define<T extends AppendDefinition<EmptyKeyObject>>(def: T) {
            for (const [name, typeOrBinder] of Object.entries(def)) {
                if (typeOrBinder === undefined) {
                    continue;
                }
                if (name in this) {
                    throw new Error(`${name} is already defined in MCUCall.`);
                }
                const address = resolveAddress(name, symbolAddresses);
                if (typeof typeOrBinder === 'function') {
                    const functionType = makeFunctionType(name, typeOrBinder);
                    Object.defineProperty(this, name, {
                        configurable: true,
                        enumerable: true,
                        value: markAsLazilyAccessObject(typeOrBinder(ctx, address, name), functionType, address),
                    });
                    Object.defineProperty(this.symbols, name, {
                        configurable: true,
                        enumerable: true,
                        value: createSymbol(ctx, address, functionType),
                    });
                } else {
                    Object.defineProperty(this, name, {
                        configurable: true,
                        enumerable: true,
                        ...createVariable(ctx, address, typeOrBinder),
                    });
                    Object.defineProperty(this.symbols, name, {
                        configurable: true,
                        enumerable: true,
                        value: createSymbol(ctx, address, typeOrBinder),
                    });
                }
            }
            return this as MCUCall<{ [k in keyof T]: ToJs<T[k]> }, { [k in keyof T]: ToSymbol<T[k]> }>;
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
        symbols: {},
        symbolNames: Object.keys(symbolAddresses),
    };
    return Object.create(resultProto);
}
