import type { LiteralUnion } from 'type-fest';
import type { MCUAllocation, MCUAllocator } from './allocation.js';
import type { MemoryAddress, NativeType } from './core.js';
import type { MCUReference } from './reference.js';
import type { MCUSymbol, ToSymbol } from './symbol.js';
import type { InoutRef, OutRef } from './type/ref.js';
import type { MCUSpan } from './type/span.js';

/** @inline */
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
 * The low-level hardware link instance.
 */
export interface MCULink {
    cpu: {
        halt(): boolean;
        isHalted(): boolean;
        resume(): void;
    };
    memory: {
        read(address: number, buffer: Buffer): number;
        write(address: number, buffer: Buffer): number;
    };
    register: {
        read(registerName: string): number;
        write(registerName: string, value: number): void;
        readMany<K extends string>(
            registers: K[],
        ): {
            [k in K]: number;
        };
        writeMany(registers: Record<string, number>): void;
    };
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
    /** @hidden */
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
    /** @hidden */
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
 * Converts a function definition to a type definition.
 */
export type ToFunctionType<F extends MCUFunctionDef> = MCUTypeDef<ToJsFunction<F>>;

/**
 * Coerces a type to a `MCUTypeDef`.
 */
export type AsTypeDef<T> = T extends MCUTypeDef ? T : T extends MCUFunctionDef ? ToFunctionType<T> : never;

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

export type AppendDefinition<Definitions extends Record<string, MCUTypeDef | MCUFunctionDef>> = {
    [name: string]: MCUTypeDef | MCUFunctionDef;
} & {
    [K in keyof MCUCall<Definitions>]?: never;
};

/**
 * MCU call instance.
 */
export type MCUCall<Definitions extends Record<string, MCUTypeDef | MCUFunctionDef> = EmptyKeyObject> = {
    /**
     * Define a variable or function.
     *
     * Searches the symbol table for the address, then exposes the symbol on the instance.
     * Throws if a symbol is not found or already defined.
     *
     * @param def Symbol name and type pairs.
     */
    define<T extends AppendDefinition<Definitions>>(
        def: T,
    ): MCUCall<
        Definitions & {
            [k in keyof T]: T[k];
        }
    >;

    /**
     * Define a variable or function, making it optional.
     *
     * Searches the symbol table for the address, then exposes the symbol on the instance.
     * Unlike `define()`, missing symbols are silently skipped instead of throwing an error.
     * Already defined symbols will still throw an error.
     *
     * @param def Symbol name and type pairs.
     */
    defineOptional<T extends AppendDefinition<Definitions>>(
        def: T,
    ): MCUCall<
        Definitions & {
            [k in keyof T]?: T[k];
        }
    >;

    /**
     * Try to define a variable or function.
     *
     * Searches the symbol table for the address, then exposes the symbol on the instance.
     * Returns `true` if all symbols are successfully defined, `false` otherwise.
     * Unlike `define()`, this method returns a boolean instead of throwing on conflicts or missing symbols.
     *
     * @param def Symbol name and type pairs.
     * @returns `true` if all symbols were defined; `false` if a symbol was not found or already defined.
     */
    tryDefine<T extends AppendDefinition<Definitions>>(
        def: T,
    ): this is MCUCall<
        Definitions & {
            [k in keyof T]: T[k];
        }
    >;

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
    symbols: {
        [k in keyof Definitions]: ToSymbol<Definitions[k]>;
    };

    /**
     * Alias for `symbols`.
     */
    $: {
        [k in keyof Definitions]: ToSymbol<Definitions[k]>;
    };

    /**
     * List of symbol names.
     */
    symbolNames: string[];
} & {
    [v in keyof Definitions]: ToJs<Definitions[v]>;
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
