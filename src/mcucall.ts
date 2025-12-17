import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { type CustomInspectFunction, inspect } from 'node:util';
import type { LiteralUnion, Promisable } from 'type-fest';
import { alignedCeil, alignedFloor } from './binparse.js';
import { analyzeELF } from './elf.js';

const NativeType = Symbol('nativeType');
const MemoryAddress = Symbol('memoryAddress');

// biome-ignore lint/complexity/noBannedTypes: T extends Record<...> && keyof T extends never
export type EmptyKeyObject = {};

/**
 * 代理对象。
 *
 * 对代理对象的访问与修改会自动进行序列化/反序列化，并同步至 MCU 内存。
 */
export type LazilyAccessObject<T = object> = T & {
    readonly [NativeType]: MCUTypeDef<T>;
    readonly [MemoryAddress]: number;
};
export type LazilyAccessObjectOrValue<T> = T extends object ? LazilyAccessObject<T> : T;

/**
 * MCU 交互接口。参见 JLink。
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
 * 符号表。
 */
export type SymbolAddresses = Record<string, number>;

/**
 * MCU 调用上下文。
 */
export interface MCUContext {
    /**
     * MCU 交互接口。
     */
    link: MCULink;

    /**
     * 内存分配器。
     */
    allocator: MCUAllocator;

    /**
     * 符号表。
     */
    symbolAddresses: SymbolAddresses;

    /**
     * 断点代码地址。
     */
    breakpoint: number | undefined;

    /**
     * 堆基址。
     */
    heapBase: number | undefined;

    /**
     * 堆上限地址。
     */
    heapLimit: number | undefined;

    /**
     * 调用超时时间，单位为毫秒。
     */
    callTimeout: number;
}

/**
 * MCUTypeDef 接口标签。存储对应的 JavaScript 类型。
 *
 * 该符号只有类型信息，实际上该导出变量并不存在。
 */
export declare const typeTag: unique symbol;

/**
 * 类型定义。描述类型如何在内存/栈/寄存器中存储，以及序列化与反序列化的方式。
 */
export interface MCUTypeDef<T = unknown, N extends SymbolDefintions = EmptyKeyObject> {
    [typeTag]: T;

    /**
     * 类型的符号命名空间。
     */
    symbols: N;

    /**
     * 类型名称（例如 `char`）。
     */
    name: string;

    /**
     * 类型大小，`sizeof(Type)`，单位为字节。
     */
    size: number;

    /**
     * 对齐方式，`__alignof__(Type)`，单位为字节。
     */
    align: number;

    /**
     * 从内存中读取值。
     * @param ctx 调用上下文。
     * @param addr 内存地址。
     * @param buffer 提前读取的缓冲区（如有）。尽可能使用该缓冲区以减少单独读取的开销。
     * @param offset 值在该缓冲区中的位置。
     */
    fromMemory(ctx: MCUContext, addr: number, buffer?: Buffer, offset?: number): T;

    /**
     * 向内存中写入值。
     *
     * 如果提供了 `buffer` 且需要向 `addr` 对应的内存区域写入数据，则必须将数据写入 `buffer` 中，否则写入的数据可能会被覆盖。
     * @param ctx 调用上下文。
     * @param addr 内存地址。
     * @param value 待写入的值。
     * @param buffer 延后写入的缓冲区（如有）。如果不为 `null`，写入该缓冲区而非内存中以减少单独写入的开销。
     * @param offset 值在该缓冲区中的位置。
     * @returns 如果写入了延后写入的缓冲区，返回 offset + 写入的大小，否则不返回。
     */
    toMemory(ctx: MCUContext, addr: number, value: T, buffer?: Buffer, offset?: number): number | undefined;

    /**
     * 返回一个代理对象。当它的成员被访问时才会实际执行访问操作。
     *
     * 如果该类型无法实现懒访问，则会使用 `fromMemory`。
     * @param ctx 调用上下文。
     * @param addr 内存地址。
     */
    lazilyAccess(this: MCUTypeDef<T, N>, ctx: MCUContext, addr: number): LazilyAccessObjectOrValue<T>;

    /**
     * 将寄存器形式的值转换为原始值。一般用于读取函数的返回值。
     * @param ctx 调用上下文。
     * @param buffer 读取的缓冲区。
     * @param offset 值在该缓冲区中的位置。
     */
    fromRegister(ctx: MCUContext, buffer: Buffer, offset: number): T;

    /**
     * 将值转换为寄存器/栈中的形式。一般用于向函数传递参数。
     * @param ctx 调用上下文。
     * @param value 待写入的值。
     * @param buffer 延后写入的缓冲区（如有）。如果不为 `null`，写入该缓冲区而非内存中以减少单独写入的开销。
     * @param offset 值在该缓冲区中的位置。
     * @returns offset + 写入的大小。
     */
    toRegister(ctx: MCUContext, value: T, buffer: Buffer, offset: number): number;
}

/**
 * 类型定义的 JavaScript 表示。
 */
export type ToJsType<T extends MCUTypeDef> = T[typeof typeTag];

/**
 * 收窄类型定义。
 * @param type 类型定义。
 */
export function narrowType<T extends MCUTypeDef>(type: T) {
    return {
        as<N extends ToJsType<T>>() {
            return type as MCUTypeDef<N, T['symbols']>;
        },
    };
}

/**
 * 符号定义。
 */
export type MCUSymbolDef<T extends MCUTypeDef = MCUTypeDef> = {
    /**
     * 类型定义。
     */
    type: T;
    /**
     * 相对于父类型的地址偏移量。
     */
    address: number;
};
/**
 * 符号定义表。
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
               * 从缓冲区中读取值。如果没有提前读取缓冲区，将创建一个缓冲区并读取对应的内存区域。
               * @param buffer 用于读取的缓冲区。
               * @param offset 值在该缓冲区中的位置。
               * @param ctx 调用上下文。
               * @param addr 内存地址。当读取源为寄存器时，不提供该值。
               */
              deserialize(buffer: Buffer, offset: number, ctx: MCUContext, addr?: number): T;
          }
    ) &
    (
        | Pick<MCUTypeDef<T, N>, 'toMemory'>
        | {
              toMemory?: undefined;

              /**
               * 向缓冲区中写入值。如果没有延后写入缓冲区，将创建一个缓冲区并在写入后将缓冲区自动写入对应的内存区域。。
               * @param buffer 用于写入的缓冲区。
               * @param offset 值在该缓冲区中的位置。
               * @param value 待写入的值。
               * @param ctx 调用上下文。
               * @param addr 内存地址。当写入目标为寄存器时，不提供该值。
               * @returns 如果写入了缓冲区，返回 offset + 写入的大小。
               */
              serialize(buffer: Buffer, offset: number, value: T, ctx: MCUContext, addr?: number): number;
          }
    );

/**
 * 定义一个类型。会补全部分可选的参数。
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
 * `void` 类型。
 */
export const voidType = mcuType<void>('void_t', 0, {
    fromMemory: () => undefined,
    toMemory: (_ctx, _addr, _value, buffer, offset) => (buffer ? offset : undefined),
    fromRegister: () => undefined,
});

/**
 * `void` 类型。
 */
export type VoidType = typeof voidType;

/**
 * `never` 类型。当返回值为该类型时，不会等待调用结束。
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
 * `never` 类型。
 */
export type NeverType = typeof neverType;

/**
 * 从内存或缓冲区中反序列化数据为指定类型的值。
 * @param ctx MCU 调用上下文。
 * @param type MCU 类型定义。
 * @param buffer 可选的缓冲区。
 * @param offset 缓冲区中的偏移量。
 * @param addr 可选的内存地址。
 * @returns 反序列化后的值。
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
    throw new Error(`Source is unknown.`);
}

/**
 * 将指定类型的值序列化到内存或缓冲区中。
 * @param ctx MCU 调用上下文。
 * @param type MCU 类型定义。
 * @param value 要序列化的值。
 * @param buffer 可选的缓冲区。
 * @param offset 缓冲区中的偏移量。
 * @param addr 可选的内存地址。
 * @returns 写入的字节数。
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
    throw new Error(`Target is unknown.`);
}

/**
 * 根据地址与类型生成属性描述符。
 * @param ctx MCU 调用上下文。
 * @param addr 内存地址。
 * @param type 类型定义。
 * @returns 属性描述符。
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
 * 创建懒访问器。懒访问器会在懒访问时通过指定的函数获取代理对象，添加类型与地址标记，并自动缓存。
 * @param handler 获取代理对象的函数。
 */
export function createLazilyAccessor<T>(
    handler: (ctx: MCUContext, address: number, type: MCUTypeDef<T>) => T = defaultLazilyAccessorHandler,
) {
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
 * 创建懒访问器。懒访问器会在懒访问时基于操作处理器创建代理对象，添加类型与地址标记，并自动缓存。
 * @param handlers 代理操作处理器。
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
            }) as CustomInspectFunction,
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
 * 标记对象为代理对象。
 * @param value 对象。
 * @param type 类型定义。
 * @param address 内存地址。
 */
export function markAsLazilyAccessObject<T>(value: T, type: MCUTypeDef<T>, address: number) {
    if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
        Object.defineProperty(value, NativeType, { value: type });
        Object.defineProperty(value, MemoryAddress, { value: address });
    }
    return value as LazilyAccessObjectOrValue<T>;
}

/**
 * 判断对象是否为代理对象。
 * @param value 对象。
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
 * 将代理对象转换为原始对象。对转换后的对象的读写不会影响内存中的对象。
 * @param ctx MCU 调用上下文。
 * @param value 代理对象。
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
 * 构造对应类型的外设类型。读写外设类型时，总会直接读写 MCU 内存，而非使用提前读取缓冲区。
 * @param type 类型定义。
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

/**
 * 构造数组类型。
 * @param type 数组元素的类型。
 * @param length 数组长度。
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
 * 构造缓冲区类型。该类型不支持代理对象，修改完成后需要重新赋值。
 * @param size 缓冲区大小。
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
 * 构造类型化数组类型。该类型不支持代理对象，修改完成后需要重新赋值。
 * @param ctor 类型化数组的构造函数。
 * @param length 类型化数组的长度。
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
 * 构造枚举类型。
 * @param name 枚举类型的名称。
 * @param baseType 枚举的基础类型。
 * @param enumDef 枚举定义对象。键为枚举名称，值为枚举值。
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
 * 构造标志类型。
 * @param name 标志类型的名称。
 * @param baseType 标志的基础类型。
 * @param flagDef 标志定义对象。键为标志名称，值为标志值。
 */
export function makeFlags<B extends MCUTypeDef<number>, T extends { [key: string]: ToJsType<B> }>(
    name: string,
    baseType: B,
    flagDef: T,
) {
    const flagDefEntries = Object.entries(flagDef) as [keyof T, ToJsType<B>][];
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

export type StructDefToTypeMap<T extends Record<string, MCUTypeDef | [MCUTypeDef, number?]>> = {
    [K in keyof T]: T[K] extends MCUTypeDef ? T[K] : T[K] extends [infer U extends MCUTypeDef, number?] ? U : never;
};

/**
 * 构造结构体类型。
 * @param name 结构体类型的名称。
 * @param structDef 结构体定义对象。键为字段名称，值为字段类型或类型与偏移量的元组。
 * @param align 可选的对齐方式。默认为字段自身的对齐方式。
 */
export function makeStructure<T extends Record<string, MCUTypeDef | [type: MCUTypeDef, offset?: number]>>(
    name: string,
    structDef: T,
    align?: number,
) {
    type StructDef = StructDefToTypeMap<T>;
    let size = 0;
    const entries = [] as [string, MCUTypeDef, number][];
    const entryMap = new Map<string, [MCUTypeDef, number]>();
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
        entries.push([key, type, offset]);
        entryMap.set(key, [type, offset]);
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
            for (const [key, type, entOffset] of entries) {
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
            for (const [key, type, entOffset] of entries) {
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
                const [type, offset] = entryMap.get(p)!;
                return type.lazilyAccess(ctx, address + offset);
            },
            set(ctx, address, p, newValue) {
                const [type, offset] = entryMap.get(p)!;
                type.toMemory(ctx, address + offset, newValue);
                return true;
            },
        }),
    });
    return structType;
}

/**
 * 构造联合类型。
 * @param name 联合类型的名称。
 * @param unionDef 联合类型定义对象。键为成员名称，值为成员类型。
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
 * 输入引用类型。
 */
export type InRef<T> = T | null | undefined;

/**
 * 构造输入引用类型。
 * @param pointerType 指针的基础类型。
 * @param type 引用的目标类型。
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
 * 输出引用类型。
 */
export type OutRef<T> = [T?];

/**
 * 构造输出引用类型。
 * @param pointerType 指针的基础类型。
 * @param type 引用的目标类型。
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
 * 输入输出引用类型。
 */
export type InoutRef<T> = [T];

/**
 * 构造输入输出引用类型。
 * @param pointerType 指针的基础类型。
 * @param type 引用的目标类型。
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
 * 引用类型构造器。
 */
export type ReferenceType = {
    <T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    in<T extends MCUTypeDef>(type: T): MCUTypeDef<InRef<ToJsType<T>>>;
    out<T extends MCUTypeDef>(type: T): MCUTypeDef<OutRef<ToJsType<T>>>;
    inout<T extends MCUTypeDef>(type: T): MCUTypeDef<InoutRef<ToJsType<T>>>;
};

/**
 * 构造引用类型构造器。
 * @param pointerType 指针的基础类型。
 */
export function makeReferenceType(pointerType: MCUTypeDef<number>) {
    const ref: ReferenceType = <T extends MCUTypeDef>(type: T) => makeInReference(pointerType, type);
    ref.in = ref;
    ref.out = <T extends MCUTypeDef>(type: T) => makeOutReference(pointerType, type);
    ref.inout = <T extends MCUTypeDef>(type: T) => makeInoutReference(pointerType, type);
    return ref;
}

/**
 * 指针类型。
 */
export interface MCUPointer<T extends MCUTypeDef = MCUTypeDef> {
    address: number;
    value: ToJsType<T>;
    readonly symbol: MCUSymbol<T>;
}

/**
 * 构造指针类型。
 * @param pointerType 指针的基础类型。
 * @param type 指针指向的目标类型。
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
 * 构造指针类型构造器。
 * @param pointerType 指针的基础类型。
 */
export function makePointerType(pointerType: MCUTypeDef<number>) {
    return <T extends MCUTypeDef>(type: T) => makePointer(pointerType, type);
}

/**
 * 表示一段内存区域。
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
     * 获取当前内存区域的子区域。
     * @param start 起始位置。
     * @param end 结束位置。默认为区域末尾。
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
     * 将当前内存区域强制转换成指定类型的代理对象。
     * @param type 指定类型。
     * @param offset 偏移量。
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
     * 将当前内存区域强制转换成指定类型的函数。
     * @param def 指定类型。
     * @param offset 偏移量。
     */
    bind<F extends (...args: never[]) => unknown>(def: MCUFunctionDef<F>, offset: number = 0): ToAsyncFunction<F> {
        if (offset !== undefined && !this.checkValidIndex(offset)) {
            throw new Error('Invalid offset');
        }
        return def(this.context, this.address + offset, '(anonymous)');
    }

    /**
     * 读取当前内存区域中的数据，并反序列化为指定类型。
     * @param type 数据类型。
     * @param offset 偏移量。
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
     * 将指定数据序列化后写入当前内存区域。
     * @param type 数据类型。
     * @param value 数据值。
     * @param offset 偏移量。
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
     * 创建当前内存区域中的数据引用。
     * @param type 数据类型。
     * @param offset 偏移量。
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
     * 将当前内存区域的数据复制到目标内存区域。
     * @param target 目标内存区域。
     * @param targetStart 目标内存区域的起始位置。默认为0。
     * @param sourceStart 当前内存区域的起始位置。默认为0。
     * @param sourceEnd 当前内存区域的结束位置。默认为区域末尾。
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
     * 将当前内存区域中的数据复制到新分配缓冲区并返回。
     * @param start 内存区域的起始位置。默认为0。
     * @param end 内存区域的结束位置。默认为区域末尾。
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
     * 将当前内存区域中的数据复制到本地缓冲区。
     * @param target 本地缓冲区。
     * @param targetStart 目标缓冲区的起始位置。默认为0。
     * @param sourceStart 源内存区域的起始位置。默认为0。
     * @param sourceEnd 源内存区域的结束位置。默认为区域末尾。
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
     * 将本地缓冲区的数据写入当前内存区域。
     * @param source 本地缓冲区。
     * @param sourceStart 源缓冲区的起始位置。默认为0。
     * @param targetStart 目标内存区域的起始位置。默认为0。
     * @param targetEnd 目标内存区域的结束位置。默认为区域末尾。
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
 * 构造内存区域类型。
 * @param size 内存区域的大小。若未指定则表示无限大小。
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
 * 将函数类型转换为异步函数类型。
 */
export type ToAsyncFunction<F extends (...args: never[]) => unknown> = (
    ...args: Parameters<F>
) => Promise<Awaited<ReturnType<F>>>;

/**
 * MCUFunctionDef 接口标签。存储对应的 JavaScript 函数签名。
 *
 * 该符号只有类型信息，实际上该导出变量并不存在。
 */
export declare const signatureTag: unique symbol;

/**
 * 函数定义。描述函数的参数和返回值类型。
 */
export type MCUFunctionDef<F extends (...args: never[]) => unknown = (...args: never[]) => unknown> = {
    [signatureTag]: F;
    (ctx: MCUContext, address: number, name: string): ToAsyncFunction<F>;
};

/**
 * 函数定义对应的 JavaScript 表示。
 */
export type ToJsFunction<T extends MCUFunctionDef> = ToAsyncFunction<T[typeof signatureTag]>;

/**
 * 函数或类型定义对应的 JavaScript 表示。
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
 * 函数工厂。
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
 * 详见 {@link makeCallConvention}。
 */
export type CallFactoryCleanUp<F extends (...args: never[]) => unknown> = (
    error?: null | Error,
) => Promisable<ReturnType<F>>;
/**
 * 详见 {@link makeCallConvention}。
 */
export type CallFactoryPrepare<F extends (...args: never[]) => unknown> = (
    ...args: Parameters<F>
) => Promisable<CallFactoryCleanUp<F>>;
/**
 * 详见 {@link makeCallConvention}。
 */
export type CallFactoryInitialize = <F extends (...args: never[]) => unknown>(
    ctx: MCUContext,
    address: number,
    name: string,
    returnType: MCUTypeDef<ReturnType<F>>,
    ...argumentTypes: WrapParametersToType<Parameters<F>>
) => CallFactoryPrepare<F>;

/**
 * 创建调用约定。
 *
 * - {@link CallFactoryInitialize} 初始化堆栈结构。在定义函数时被调用。
 * - {@link CallFactoryPrepare} 用给定参数填充给寄存器与堆栈。在调用函数时被调用。
 * - {@link CallFactoryCleanUp} 恢复寄存器与堆栈，获取返回值（如果成功）。在函数调用结束或出错后被调用。
 *
 * @param initialize 调用约定初始化函数。
 * @returns 函数工厂。
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
 * 创建复合调用约定。
 *
 * 复合调用约定适用于返回类型为大于 4 字节的复合类型的情形。函数被调用时会修改第一个参数指向的内存，从而实现返回复合类型。
 *
 * @param factory 原始函数工厂。
 * @param outRefType 输出引用类型。
 * @returns 函数工厂。
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
                out: [ReturnType<F>?],
                ...args: Parameters<F>
            ) => Promise<void>;
            const wrapped = async (...args: Parameters<F>) => {
                const outRef: [ReturnType<F>?] = [];
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
 * 构造函数类型。
 * @param name 函数类型的名称。
 * @param def 函数定义。
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
    let definedSize: number | undefined;
    Object.defineProperty(type, 'size', {
        configurable: true,
        enumerable: true,
        get() {
            if (definedSize !== undefined) {
                return definedSize;
            }
            throw new Error(`Cannot determine the size of function type ${name}.`);
        },
        set(value) {
            definedSize = Number.isNaN(value) ? undefined : value;
        },
    });
    return type;
}

/**
 * 堆内存分配。需要手动调用 `free()` 释放。
 */
export interface MCUAllocation {
    /**
     * 内存地址。
     */
    readonly address: number;
    /**
     * 内存大小。
     */
    readonly size: number;
    /**
     * 内存对齐方式。
     */
    readonly align?: number;
    /**
     * 释放内存。
     */
    free(): void;
    [Symbol.dispose](): void;
}

/**
 * 栈内存分配。会在函数返回时自动释放。
 */
export interface MCUAutoAllocation {
    /**
     * 内存地址。
     */
    readonly address: number;
    /**
     * 内存大小。
     */
    readonly size: number;
    /**
     * 内存对齐方式。
     */
    readonly align?: number;
    /**
     * 终结器。在释放时自动调用。
     */
    finalize?: () => void;
}

export interface MCUFinalizer {
    finalize(): void;
}

/**
 * 内存分配器。
 */
export interface MCUAllocator {
    /**
     * 尝试从栈中分配内存。未持有栈控制权或栈中没有足够大的空间时会返回 `null`。
     *
     * @param ctx 调用上下文。
     * @param size 待分配内存的大小。
     * @param align 待分配内存的对齐方式。
     * @returns 栈内存分配。
     */
    allocateAuto(ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null;

    /**
     * 尝试从堆中分配内存。未持有堆控制权或堆中没有足够大的空间时会返回 `null`。
     *
     * @param ctx 调用上下文。
     * @param size 待分配内存的大小。
     * @param align 待分配内存的对齐方式。
     * @returns 堆内存分配。
     */
    allocate(ctx: MCUContext, size: number, align?: number): MCUAllocation | null;

    /**
     * 授予栈控制权，同时提供修改栈指针的方式。返回回收器。
     *
     * 调用该回收器会导致栈控制权被回收，并返回终结器。调用回收器后从栈中分配内存的尝试将失败。但已分配的内存仍能使用。
     *
     * 调用该终结器会导致所有从栈中分配的内存被释放。
     *
     * @param ctx 调用上下文。
     * @param commit 栈指针的修改函数。提交偏移量，返回新的栈指针。
     */
    stackAccess(ctx: MCUContext, commit: (stackOffset?: number) => number | null): () => MCUFinalizer;

    /**
     * 授予堆控制权。堆控制权不能被回收。
     *
     * @param ctx 调用上下文。
     */
    heapAccess(ctx: MCUContext): void;
}

export class DefaultStackAllocator implements MCUAllocator {
    protected allocations = new Set<MCUAllocation>();
    protected freeBlocks: [number, number][] = [];
    protected autoAllocations = new Set<MCUAutoAllocation>();
    protected commitStack?: (stackOffset?: number) => number | null;
    allocateAuto(_ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null {
        const commitStack = this.commitStack;
        if (!commitStack) {
            return null;
        }
        const oldStackPointer = commitStack();
        if (oldStackPointer === null) {
            return null;
        }
        let stackPointer = oldStackPointer - size;
        if (align !== undefined) {
            stackPointer = alignedFloor(stackPointer, align);
        }
        const address = commitStack(stackPointer - oldStackPointer);
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
    stackAccess(_ctx: MCUContext, commit: (stackOffset?: number) => number | null): () => MCUFinalizer {
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
    heapAccess(ctx: MCUContext): void {
        if (this.freeBlocks.length > 0) {
            throw new Error(`heapAccess is called twice.`);
        }
        if (ctx.heapBase) {
            this.freeBlocks = [[ctx.heapBase, ctx.heapLimit ?? Infinity]];
            this.allocations.clear();
        }
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
 * 将地址格式化为符号名与偏移的形式。
 * @param symbolAddresses 符号表。
 * @param address 地址。
 * @param searchUpperBound 搜索范围上限。
 * @param searchLowerBound 搜索范围下限。
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
 * 符号树。可用于访问层级结构的符号与子符号。
 */
export type MCUSymbol<T extends MCUTypeDef = MCUTypeDef> = {
    [NativeType]: T;
    [MemoryAddress]: number;
} & MCUSymbolMap<T['symbols']>;

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
        }) as CustomInspectFunction,
    });
    Object.defineProperty(target, Symbol.toStringTag, {
        configurable: false,
        enumerable: false,
        value: type.name,
    });
    return target;
}

/**
 * 引用。允许对不支持代理对象的类型提供对内存的响应式操作。
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
 * 地址表示。可以是符号名称或地址数值。
 */
export type AddressLike<Definitions extends Record<string, unknown> = EmptyKeyObject> = LiteralUnion<
    keyof Definitions,
    string | number
>;

/**
 * 可寻址对象。可以获取该对象在内存中的地址。
 */
export type Addressable = MCUSymbol | MCUReference<MCUTypeDef> | MCUSpan | LazilyAccessObject | Record<never, never>;

/**
 * 类型限定对象。可以获取该对象的类型定义。
 */
export type TypedValue<T extends MCUTypeDef> = MCUSymbol<T> | MCUReference<T>;

/**
 * 类型限定可寻址对象。可以获取该对象的地址与类型定义。
 */
export type TypedAddressable<T extends MCUTypeDef> = MCUSymbol<T> | MCUReference<T>;

export type AppendDefinition<Definitions extends Record<string, unknown>> = {
    [name: string]: MCUTypeDef | MCUFunctionDef;
} & { [K in keyof MCUCall<Definitions>]?: never };

/**
 * MCU 调用实例。
 */
export type MCUCall<
    Definitions extends Record<string, unknown> = EmptyKeyObject,
    Symbols extends Record<string, unknown> = EmptyKeyObject,
> = {
    /**
     * 定义变量或函数。定义时会在符号表中搜索指定的符号，并获取其地址。定义后可通过该地址在 MCU 调用实例中对其进行操作。
     *
     * @param def 符号名与类型组成的键值对。
     */
    define<T extends AppendDefinition<Definitions>>(
        def: T,
    ): MCUCall<Definitions & { [k in keyof T]: ToJs<T[k]> }, Symbols & { [k in keyof T]: ToSymbol<T[k]> }>;

    /**
     * 获取数值形式的地址。
     *
     * @param symbol 地址、符号名或可寻址对象。
     */
    addressOf(symbol: AddressLike<Definitions> | Addressable): number;

    /**
     * 获取类型定义。
     *
     * @param symbol 类型限定对象。
     */
    typeOf<T extends MCUTypeDef>(symbol: TypedValue<T>): T;

    /**
     * 获取类型大小。
     *
     * @param symbol 类型限定对象。
     */
    sizeOf<T extends MCUTypeDef>(symbol: TypedValue<T>): number;

    // biome-ignore format: https://github.com/biomejs/biome/issues/8354
    /**
     * 尝试在堆中为指定类型分配内存，并返回内存分配与引用。
     * @param type 类型定义。
     */
    'new'<T extends MCUTypeDef>(type: T): MCUAllocation & MCUReference<T>;

    /**
     * 强制将指定地址的对象读取为另一种类型的代理对象。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param type 类型定义。
     */
    cast<T>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: MCUTypeDef<T>): T;

    /**
     * 强制将指定地址的对象读取为函数。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param def 函数定义。
     */
    bind<F extends (...args: never[]) => unknown>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        def: MCUFunctionDef<F>,
    ): ToAsyncFunction<F>;

    /**
     * 读取指定地址处的数据，并反序列化为指定类型。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param type 数据类型。
     */
    read<T extends MCUTypeDef>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: T): ToJsType<T>;

    /**
     * 将指定数据序列化后写入指定地址。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param type 数据类型。
     * @param value 数据。
     */
    write<T extends MCUTypeDef>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        type: T,
        value: ToJsType<T>,
    ): void;

    /**
     * 根据地址与类型创建符号。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param type 数据类型。
     */
    symbolOf<T extends MCUTypeDef>(symbolOrAddress: AddressLike<Definitions> | Addressable, type: T): MCUSymbol<T>;
    symbolOf<T extends MCUTypeDef>(symbolOrAddress: TypedAddressable<T>, type?: T): MCUSymbol<T>;

    /**
     * 根据地址与类型创建引用。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param type 数据类型。
     */
    referenceOf<T extends MCUTypeDef>(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        type: T,
    ): MCUReference<T>;
    referenceOf<T extends MCUTypeDef>(symbolOrAddress: TypedAddressable<T>, type?: T): MCUReference<T>;

    /**
     * 创建内存区域对象。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param size 区域大小。如果未指定则默认使用 symbolOrAddress 的类型大小（如有）或无限大小。
     */
    spanOf(symbolOrAddress: AddressLike<Definitions> | Addressable, size?: number): MCUSpan;

    /**
     * 将代理对象转换为原始对象。对转换后的对象的读写不会影响内存中的对象。
     * @param value 代理对象。
     */
    snapshot<T>(value: T): T;

    /**
     * 创建输入引用对象。
     * @param value 引用对象。
     */
    ref<T>(value: T): InoutRef<T>;

    /**
     * 创建输出引用对象。
     */
    ref<T>(): OutRef<T>;

    /**
     * 将地址格式化为符号名与偏移的形式。
     * @param symbolOrAddress 地址、符号名或可寻址对象。
     * @param searchUpperBound 搜索范围上限。
     * @param searchLowerBound 搜索范围下限。
     */
    locate(
        symbolOrAddress: AddressLike<Definitions> | Addressable,
        searchUpperBound?: number,
        searchLowerBound?: number,
    ): string;

    /**
     * MCU 调用上下文。
     */
    context: MCUContext;

    /**
     * 符号表。
     */
    symbols: Symbols;

    /**
     * 符号名列表。
     */
    symbolNames: string[];
} & {
    [v in keyof Definitions]: Definitions[v];
};

export interface MCUCallOptions {
    /**
     * 内存偏移量。查找符号时对应的符号会加上相应的偏移。
     */
    memoryOffset?: number;

    /**
     * 断点代码位于内存中的地址或符号名。当 MCU 执行到断点时，MCU 会进入暂停状态。
     *
     * 默认为 `BKPT_FUNCTION` 符号。如果未找到，调用工厂会在调用函数前在栈中添加断点代码，在函数返回后恢复。
     *
     * 如果 MCU 不支持执行栈中的代码时，需要手动指定断点代码的位置。
     */
    breakpoint?: number | string;

    /**
     * 堆内存起始地址或符号名。
     *
     * 默认为 `HEAP_BASE` 或 `__heap_base` 符号。
     */
    heap?: number | string;

    /**
     * 堆内存最大地址或符号名。
     *
     * 默认为 `HEAP_LIMIT` 或 `__heap_limit` 符号。
     */
    heapLimit?: number | string;

    /**
     * 堆内存大小。默认为 `Infinity`。
     */
    heapSize?: number;

    /**
     * 自定义内存分配器。可以继承 {@link DefaultStackAllocator} 实现自定义逻辑。
     */
    allocator?: MCUAllocator;

    /**
     * 调用超时时间，单位为毫秒。函数调用超过该时间后仍未返回时，调用将抛出异常。
     *
     * 默认为 `Infinity`。
     */
    callTimeout?: number;
}

/**
 * 创建 MCU 调用实例。
 * @param link JLink 等 MCU 底层实例。
 * @param symbolSource ELF 文件路径，内容或符号表。
 * @param options MCU 调用选项。
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
    const allocator = options?.allocator ?? new DefaultStackAllocator();
    const breakpoint = resolveAddress(options?.breakpoint, symbolAddresses, 'BKPT_FUNCTION');
    const heapBase = resolveAddress(options?.heap, symbolAddresses, 'HEAP_BASE', '__heap_base');
    const heapLimit = resolveAddress(options?.heapLimit, symbolAddresses, 'HEAP_LIMIT', '__heap_limit');
    const heapLimitBySize = heapBase !== undefined && options?.heapSize ? heapBase + options.heapSize : undefined;
    const ctx = {
        link,
        allocator,
        symbolAddresses,
        breakpoint,
        heapBase,
        heapLimit: heapLimitBySize ?? heapLimit,
        callTimeout: options?.callTimeout ?? Infinity,
    } as MCUContext;
    ctx.allocator.heapAccess(ctx);
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
                    // ignore unreadable size
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
