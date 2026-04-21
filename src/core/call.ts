import { setImmediate } from 'node:timers/promises';
import type { Promisable } from 'type-fest';
import { neverType } from './type/never.js';
import type { OutRef } from './type/ref.js';
import { voidType } from './type/void.js';
import type { CallFactory, MCUContext, MCUFunctionDef, MCUTypeDef, ToJsType, WrapParametersToType } from './types.js';

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
                if (!link.cpu.isHalted()) {
                    link.cpu.halt();
                    running = true;
                }
                const cleanup = await prepare(...args);
                link.cpu.resume();

                if (returnType === neverType) {
                    return new Promise<never>(() => {});
                }

                const maxTime = Date.now() + ctx.callTimeout;
                while (!link.cpu.isHalted()) {
                    if (Number.isFinite(maxTime) && Date.now() > maxTime) {
                        link.cpu.halt();
                        const timeoutError = new Error(`Function execution exceeded timeout of ${ctx.callTimeout}ms.`);
                        await cleanup(timeoutError);
                        throw timeoutError;
                    }
                    await setImmediate();
                }

                const returnValue = await cleanup(null);
                if (running) {
                    link.cpu.resume();
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
