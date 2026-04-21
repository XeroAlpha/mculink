import { endianness as getOSEndianness } from 'node:os';
import { type JLinkMethods, throwJLinkError } from './binding.js';
import type { JLink } from './index.js';

const rwBuffer = Buffer.allocUnsafeSlow(4).fill(0);

export class JLinkMemory {
    private methods: JLinkMethods;
    endianness = getOSEndianness();

    /** @hidden */
    constructor(jlink: JLink, methods: JLinkMethods) {
        this.methods = methods;
        jlink.on('connected', (device) => {
            if (device) {
                if (device.endianMode === 0) {
                    this.endianness = 'LE';
                } else if (device.endianMode === 1) {
                    this.endianness = 'BE';
                }
            }
        });
    }

    /**
     * Read memory from the target device.
     * @param address Memory address.
     * @param buffer Buffer to store the data.
     * @param access Access type. Defaults to 0.
     * @returns Bytes read.
     */
    read(address: number, buffer: Buffer, access: number = 0) {
        const unitsRead = this.methods.readMemEx(address, buffer.length, buffer, access);
        if (unitsRead < 0) {
            throwJLinkError(unitsRead);
        }
        return unitsRead;
    }

    /**
     * Read memory and return a new buffer.
     * @param address Memory address.
     * @param bytes Bytes to read.
     * @returns Buffer containing the data.
     */
    readImmediate(address: number, bytes: number) {
        const buffer = Buffer.allocUnsafe(bytes);
        const unitsRead = this.read(address, buffer);
        return buffer.subarray(0, unitsRead);
    }

    /**
     * Read an 8-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readUInt8(address: number) {
        this.read(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readUInt8();
    }

    /**
     * Read an 8-bit signed integer from memory.
     * @param address Memory address.
     */
    readInt8(address: number) {
        this.read(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readInt8();
    }

    /**
     * Read a 16-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readUInt16(address: number) {
        this.read(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt16BE();
        }
        return rwBuffer.readUInt16LE();
    }

    /**
     * Read a 16-bit signed integer from memory.
     * @param address Memory address.
     */
    readInt16(address: number) {
        this.read(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt16BE();
        }
        return rwBuffer.readInt16LE();
    }

    /**
     * Read a 32-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readUInt32(address: number) {
        this.read(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt32BE();
        }
        return rwBuffer.readUInt32LE();
    }

    /**
     * Read a 32-bit signed integer from memory.
     * @param address Memory address.
     */
    readInt32(address: number) {
        this.read(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt32BE();
        }
        return rwBuffer.readInt32LE();
    }

    /**
     * Read a 32-bit float from memory.
     * @param address Memory address.
     */
    readFloat(address: number) {
        this.read(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readFloatBE();
        }
        return rwBuffer.readFloatLE();
    }

    /**
     * Write memory from a buffer.
     * @param address Memory address.
     * @param buffer Data to write.
     * @param access Access type. Defaults to 0.
     * @returns Bytes written.
     */
    write(address: number, buffer: Buffer, access: number = 0) {
        const unitsWritten = this.methods.writeMemEx(address, buffer.length, buffer, access);
        if (unitsWritten < 0) {
            throwJLinkError(unitsWritten);
        }
        return unitsWritten;
    }

    /**
     * Write memory with an internally allocated buffer.
     * @param address Memory address.
     * @param bytes Bytes to write.
     * @param bufferFiller Function to fill the buffer.
     * @returns Bytes written.
     */
    writeImmediate(address: number, bytes: number, bufferFiller: (buf: Buffer) => void) {
        const buffer = Buffer.allocUnsafe(bytes);
        bufferFiller(buffer);
        const unitsWritten = this.methods.writeMemEx(address, bytes, buffer, 0);
        if (unitsWritten < 0) {
            throwJLinkError(unitsWritten);
        }
        return unitsWritten;
    }

    /**
     * Write an 8-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeUInt8(address: number, value: number) {
        rwBuffer.writeUInt8(value);
        this.write(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * Write an 8-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeInt8(address: number, value: number) {
        rwBuffer.writeInt8(value);
        this.write(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * Write a 16-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeUInt16(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeUInt16BE(value);
        } else {
            rwBuffer.writeUInt16LE(value);
        }
        this.write(address, rwBuffer.subarray(0, 2), 2);
    }

    /**
     * Write a 16-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeInt16(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeInt16BE(value);
        } else {
            rwBuffer.writeInt16LE(value);
        }
        this.write(address, rwBuffer.subarray(0, 2), 2);
    }

    /**
     * Write a 32-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeUInt32(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeUInt32BE(value);
        } else {
            rwBuffer.writeUInt32LE(value);
        }
        this.write(address, rwBuffer.subarray(0, 4), 4);
    }

    /**
     * Write a 32-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeInt32(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeInt32BE(value);
        } else {
            rwBuffer.writeInt32LE(value);
        }
        this.write(address, rwBuffer.subarray(0, 4), 4);
    }

    /**
     * Write a 32-bit float to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeFloat(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeFloatBE(value);
        } else {
            rwBuffer.writeFloatLE(value);
        }
        this.write(address, rwBuffer.subarray(0, 4), 4);
    }
}
