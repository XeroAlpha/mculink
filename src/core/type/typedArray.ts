import { mcuType } from '../core.js';

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
        deserialize: (buffer) => {
            const newBuffer = new ArrayBuffer(byteLength);
            buffer.copy(new Uint8Array(newBuffer));
            return new ctor(newBuffer);
        },
        serialize: (buffer, value) => {
            buffer.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            if (value.byteLength < byteLength) {
                buffer.fill(0, value.byteLength, byteLength);
            }
        },
    });
}
