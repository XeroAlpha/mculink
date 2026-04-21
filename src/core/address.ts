import type { SymbolAddresses } from './types.js';

export function resolveAddress(
    addr: string | number,
    symbolAddresses: SymbolAddresses,
    ...defaultSymbols: string[]
): number;
export function resolveAddress(
    addr: string | number | undefined,
    symbolAddresses: SymbolAddresses,
    ...defaultSymbols: string[]
): number | undefined;
export function resolveAddress(
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

export function offsetAddressMap(symbolAddresses: SymbolAddresses, memoryOffset: number) {
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
