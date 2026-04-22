import { mcuType } from '../core.js';

/**
 * Construct a buffer type. Buffers are returned as static copies instead of dynamic views.
 * @param size Buffer size.
 */
export function makeBuffer(size: number) {
    return mcuType(`_Buffer_(${size})`, size, {
        deserialize: (buffer) => {
            const newBuffer = Buffer.allocUnsafe(size);
            buffer.copy(newBuffer);
            return newBuffer;
        },
        serialize: (buffer, value) => {
            value.copy(buffer);
            if (value.length < size) {
                buffer.fill(0, value.length, size);
            }
        },
    });
}
