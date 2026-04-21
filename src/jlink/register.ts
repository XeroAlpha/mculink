import { floatToUInt32, int32ToUnsigned, uint32ToFloat, uint32ToSigned } from '../util/bit-converter.js';
import { type JLinkMethods, throwJLinkError } from './binding.js';
import type { JLinkCPU } from './cpu.js';
import type { JLink } from './index.js';

export class JLinkRegisters {
    private methods: JLinkMethods;
    private cpu: JLinkCPU;
    private registerNameLookup: Record<string, number> = {};

    /** @hidden */
    constructor(jlink: JLink, methods: JLinkMethods) {
        this.methods = methods;
        this.cpu = jlink.cpu;
        jlink.on('connected', () => {
            const registerNameLookup: Record<string, number> = {};
            const registerIndices = new Array<number>(256);
            const registerCount = this.methods.getRegisterList(registerIndices, registerIndices.length);
            for (const registerIndex of registerIndices.slice(0, registerCount)) {
                const registerName = this.methods.getRegisterName(registerIndex);
                registerNameLookup[registerName] = registerIndex;
                const nameAliasMatch = registerName.match(/^(.+)\((.+)\)$/);
                if (nameAliasMatch) {
                    registerNameLookup[nameAliasMatch[1].trim()] = registerIndex;
                    registerNameLookup[nameAliasMatch[2].trim()] = registerIndex;
                }
            }
            this.registerNameLookup = registerNameLookup;
        });
    }

    /**
     * Get all available register names.
     */
    names(): string[] {
        return Object.keys(this.registerNameLookup);
    }

    /**
     * Read a register value as 32-bit unsigned integer. Throws if CPU is running or register is invalid.
     * @param registerName Register name.
     */
    read(registerName: string) {
        if (!this.cpu.isHalted()) {
            throw new Error('Cannot read register while CPU is running');
        }
        const index = this.registerNameLookup[registerName];
        if (index === undefined) {
            throw new Error(`Unknown register name: ${registerName}`);
        }
        return this.methods.readRegister(index);
    }

    /**
     * Read multiple register values as 32-bit unsigned integer.
     * @param registers Register names.
     * @returns Map of register names to values.
     */
    readMany<K extends string>(registers: K[]) {
        const result = {} as { [k in K]: number };
        for (let i = 0; i < registers.length; i++) {
            result[registers[i]] = this.read(registers[i]);
        }
        return result;
    }

    /**
     * Read a register value as 32-bit signed integer.
     * @param registerName Register name.
     */
    readInt32(registerName: string) {
        return uint32ToSigned(this.read(registerName));
    }

    /**
     * Read a register value as 32-bit float.
     * @param registerName Register name.
     */
    readFloat(registerName: string) {
        return uint32ToFloat(this.read(registerName));
    }

    /**
     * Batch read register values. Throws if CPU is running or any register is invalid.
     * @param registers Register names.
     * @returns Map of register names to values.
     */
    readBatch<K extends string>(registers: K[]) {
        if (!this.cpu.isHalted()) {
            throw new Error('Cannot read registers while CPU is running');
        }
        const result = {} as { [k in K]: number };
        const indices = new Array<number>(registers.length);
        for (let i = 0; i < registers.length; i++) {
            const index = this.registerNameLookup[registers[i]];
            if (index === undefined) {
                throw new Error(`Unknown register name: ${registers[i]}`);
            }
            indices[i] = index;
        }
        const values = new Array<number>(registers.length);
        const statuses = new Array<number>(registers.length);
        const status = this.methods.readRegisters(indices, values, statuses, registers.length);
        if (status < 0) {
            throwJLinkError(status);
        }
        for (let i = 0; i < registers.length; i++) {
            result[registers[i]] = values[i];
        }
        return result;
    }

    /**
     * Write a 32-bit unsigned integer value to a register. Throws if CPU is running or register is invalid.
     * @param registerName Register name.
     * @param value Value to write.
     */
    write(registerName: string, value: number) {
        if (!this.cpu.isHalted()) {
            throw new Error('Cannot write register while CPU is running');
        }
        const index = this.registerNameLookup[registerName];
        if (index === undefined) {
            throw new Error(`Unknown register name: ${registerName}`);
        }
        const status = this.methods.writeRegister(index, value);
        if (status !== 0) {
            throw new Error(`Write register ${registerName} failed.`);
        }
    }

    /**
     * Write 32-bit unsigned integer values to multiple registers.
     * @param registers Map of register names to values.
     */
    writeMany(registers: Record<string, number>) {
        for (const [name, value] of Object.entries(registers)) {
            this.write(name, value);
        }
    }

    /**
     * Write an 32-bit signed integer value to a register.
     * @param registerName Register name.
     * @param value Value to write.
     */
    writeInt32(registerName: string, value: number) {
        this.write(registerName, int32ToUnsigned(value));
    }

    /**
     * Write a 32-bit float value to a register.
     * @param registerName Register name.
     * @param value Value to write.
     */
    writeFloat(registerName: string, value: number) {
        this.write(registerName, floatToUInt32(value));
    }

    /**
     * Batch write register values. Throws if CPU is running or any register is invalid.
     * @param registers Map of register names to values.
     */
    writeBatch(registers: Record<string, number>) {
        if (!this.cpu.isHalted()) {
            throw new Error('Cannot write registers while CPU is running');
        }
        const names = Object.keys(registers);
        const indices = new Array<number>(names.length);
        const values = new Array<number>(names.length);
        for (let i = 0; i < names.length; i++) {
            const index = this.registerNameLookup[names[i]];
            if (index === undefined) {
                throw new Error(`Unknown register name: ${names[i]}`);
            }
            indices[i] = index;
            values[i] = registers[names[i]];
        }
        const statuses = new Array<number>(names.length);
        const status = this.methods.writeRegisters(indices, values, statuses, names.length);
        if (status < 0) {
            throwJLinkError(status);
        }
    }
}
