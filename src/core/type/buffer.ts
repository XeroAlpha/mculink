import { mcuType } from '../core.js';

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
