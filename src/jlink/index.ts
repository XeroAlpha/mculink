import EventEmitter from 'node:events';
import type koffi from 'koffi';
import type { MCULink } from '../core/index.js';
import {
    bindJLinkLibrary,
    type JLinkConnectInfo,
    type JLinkDelegates,
    type JLinkDeviceInfo,
    type JLinkDialog,
    type JLinkDialogFlags,
    type JLinkEmulatorInterfaceFlags,
    type JLinkFlashArea,
    type JLinkMethods,
    type JLinkNativeEvents,
    type JLinkRAMArea,
    type JLinkSpeed,
    JLinkSpeedAdaptive,
    JLinkTargetInterfaces,
    throwJLinkError,
    unbindJLinkLibrary,
} from './binding.js';
import { JLinkCPU } from './cpu.js';
import { JLinkDevices } from './device.js';
import { JLinkEmulators } from './emulator.js';
import { loadJLinkLibrary } from './library.js';
import { JLinkMemory } from './memory.js';
import { JLinkRegisters } from './register.js';

/**
 * J-Link exclusive session.
 */
export class JLink extends EventEmitter<JLink.Events> implements Disposable, MCULink {
    binding: koffi.IKoffiLib;

    emulator: JLinkEmulators;
    device: JLinkDevices;
    cpu: JLinkCPU;
    memory: JLinkMemory;
    register: JLinkRegisters;

    private methods: JLinkMethods;
    private delegates: JLinkDelegates;
    private disposed?: boolean;
    private processExitListener: () => void;
    private openOptions: JLink.OpenOptions | undefined;
    private connectOptions: JLink.ConnectOptions | undefined;
    private deviceName: string | undefined;

    /**
     * @param libPath Path to the J-Link library. Auto-detected if omitted.
     */
    constructor(libPath?: string | string[]) {
        super();
        this.binding = loadJLinkLibrary(libPath);
        const { methods, delegates } = bindJLinkLibrary(this.binding, this);
        this.methods = methods;
        this.delegates = delegates;
        this.processExitListener = () => {
            this[Symbol.dispose]();
        };
        process.on('exit', this.processExitListener);

        this.emulator = new JLinkEmulators(methods);
        this.device = new JLinkDevices(methods);
        this.cpu = new JLinkCPU(methods);
        this.memory = new JLinkMemory(this, methods);
        this.register = new JLinkRegisters(this, methods);
    }

    [Symbol.dispose](): void {
        if (!this.disposed) {
            process.removeListener('exit', this.processExitListener);
            this.close();
            unbindJLinkLibrary(this.delegates);
            this.binding.unload();
            this.disposed = true;
        }
    }

    dispose() {
        this[Symbol.dispose]();
    }

    private openConnection() {
        const result = this.methods.openEx(this.delegates.log, this.delegates.error);
        if (result) {
            throw new Error(result);
        }
        if (this.methods.setHookUnsecureDialog) {
            this.methods.setHookUnsecureDialog(this.delegates.unsecureHook);
        }
    }

    /**
     * Open a connection to the J-Link emulator. Supports method chaining.
     * @param options Connection options.
     */
    open(options?: JLink.OpenOptions) {
        this.close();
        if (options?.host) {
            if (options.serialNumber) {
                this.methods.selectIPBySN(options.serialNumber);
            } else {
                const port = options.port ?? 0;
                const selectResult = this.methods.selectIP(options.host, port);
                if (selectResult === 1) {
                    throw new Error(`Could not connect to emulator at ${options.host}:${port}.`);
                }
            }
        } else if (options?.serialNumber) {
            const selectResult = this.methods.selectByUSBSN(options.serialNumber);
            if (selectResult < 0) {
                throw new Error(`No emulator with serial number ${options.serialNumber} found.`);
            }
        } else {
            const selectResult = this.methods.selectUSB(0);
            if (selectResult !== 0) {
                throw new Error(`Could not connect to default emulator.`);
            }
        }
        this.openConnection();
        this.openOptions = {
            serialNumber: options?.serialNumber,
            host: options?.host,
            port: options?.port,
        };
        return this;
    }

    /**
     * Close the connection to the J-Link emulator.
     */
    close() {
        this.methods.close();
        this.openOptions = undefined;
        this.connectOptions = undefined;
    }

    /**
     * Execute a J-Link command.
     * @param command Command to execute.
     */
    execute(command: string) {
        const errorBuffer: [string] = ['\0'.repeat(512)];
        const result = this.methods.execCommand(command, errorBuffer, errorBuffer[0].length);
        if (errorBuffer[0].length > 0) {
            throw new Error(errorBuffer[0]);
        }
        return result;
    }

    /**
     * Connect to the target device. Supports method chaining.
     * @param deviceName Device name.
     * @param options Connection options.
     */
    connect(deviceName: string, options?: JLink.ConnectOptions) {
        if (!this.methods.isOpen()) {
            this.open(options);
        }
        const tifSelectResult = this.methods.tifSelect(options?.targetInterface ?? JLinkTargetInterfaces.SWD);
        if (tifSelectResult !== 0) {
            throwJLinkError(tifSelectResult);
        }
        this.execute(`Device = ${deviceName}`);
        if (!options?.speed || options.speed === 'auto') {
            this.methods.setSpeed(0);
        } else if (options.speed === 'adaptive') {
            this.methods.setSpeed(JLinkSpeedAdaptive);
        } else {
            this.methods.setSpeed(options.speed);
        }
        if (!this.methods.isConnected()) {
            const connectResult = this.methods.connect();
            if (connectResult < 0) {
                throwJLinkError(connectResult);
            }
        }
        const deviceInfo = this.device.findSupportedOrThrow(deviceName);
        this.cpu.isHalted(); // Test whether it is connected
        this.deviceName = deviceInfo.sName;
        this.connectOptions = {
            targetInterface: options?.targetInterface,
            speed: options?.speed,
        };
        this.emit('connected', deviceInfo);
        return this;
    }

    /**
     * Reconnect to the target device using the previous configuration.
     */
    reconnect() {
        if (!this.openOptions || !this.connectOptions || !this.deviceName) {
            throw new Error('Could not find appropriate options for connecting');
        }
        const options = { ...this.openOptions, ...this.connectOptions };
        this.close();
        return this.connect(this.deviceName, options);
    }

    throwError(errorCode: number): never {
        throwJLinkError(errorCode);
    }
}

export namespace JLink {
    export type ConnectInfo = JLinkConnectInfo;
    export type DeviceInfo = JLinkDeviceInfo;
    export type Dialog = JLinkDialog;
    export type DialogFlags = JLinkDialogFlags;
    export type EmulatorInterfaceFlags = JLinkEmulatorInterfaceFlags;
    export type FlashArea = JLinkFlashArea;
    export type RAMArea = JLinkRAMArea;
    export type Speed = JLinkSpeed;
    export type CPU = JLinkCPU;
    export const CPU = JLinkCPU;
    export type Devices = JLinkDevices;
    export const Devices = JLinkDevices;
    export type Emulators = JLinkEmulators;
    export const Emulators = JLinkEmulators;
    export type Memory = JLinkMemory;
    export const Memory = JLinkMemory;
    export type Registers = JLinkRegisters;
    export const Registers = JLinkRegisters;
    export type TargetInterfaces = JLinkTargetInterfaces;
    export const TargetInterfaces = JLinkTargetInterfaces;

    /**
     * J-Link emulator open options.
     */
    export interface OpenOptions {
        host?: string;
        port?: number;
        serialNumber?: number;
    }

    /**
     * J-Link connection options.
     */
    export interface ConnectOptions extends OpenOptions {
        targetInterface?: JLinkTargetInterfaces;
        speed?: JLinkSpeed;
    }

    /** @inline */
    export interface Events extends JLinkNativeEvents {
        connected: [device: JLinkDeviceInfo];
        closed: [];
    }
}
