import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { join as joinPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { floatToUInt32, int32ToUnsigned, uint32ToFloat, uint32ToSigned } from './binparse.js';

export type JLinkConnectInfo = {
    serialNumber: number;
    connection: number;
    usbAddr: number;
    aIpAddr: number[];
    time: number;
    timeUs: number;
    hwVersion: number;
    abMacAddr: number[];
    acProduct: string;
    acNickname: string;
    acFWString: string;
    isDHCPAssignedIP: number;
    isDHCPAssignedIPIsValid: number;
    numIPConnections: number;
    numIPConnectionsIsValid: number;
    aPadding: number[];
};
// biome-ignore lint/correctness/noUnusedVariables: koffi requires global references
const JLinkConnectInfo = koffi.struct('ConnectInfo', {
    serialNumber: 'uint32_t',
    connection: 'uint8_t',
    usbAddr: 'uint32_t',
    aIpAddr: koffi.array('uint8_t', 16),
    time: 'int',
    timeUs: 'uint64_t',
    hwVersion: 'uint32_t',
    abMacAddr: koffi.array('uint8_t', 6),
    acProduct: koffi.array('char', 32, 'String'),
    acNickname: koffi.array('char', 32, 'String'),
    acFWString: koffi.array('char', 112, 'String'),
    isDHCPAssignedIP: 'char',
    isDHCPAssignedIPIsValid: 'char',
    numIPConnections: 'char',
    numIPConnectionsIsValid: 'char',
    aPadding: koffi.array('uint8_t', 34),
});

export type JLinkFlashArea = {
    addr: number;
    size: number;
};
const JLinkFlashArea = koffi.struct('FlashArea', {
    addr: 'uint32_t',
    size: 'uint32_t',
});

export type JLinkRAMArea = JLinkFlashArea & {};
const JLinkRAMArea = JLinkFlashArea;

export type JLinkDeviceInfo = {
    szStruct: number;
    sName: string;
    coreId: number;
    flashAddr: number;
    ramAddr: number;
    endianMode: number;
    flashSize: number;
    ramSize: number;
    sManufacturer: string;
    aFlashArea: JLinkFlashArea[];
    aRAMArea: JLinkRAMArea[];
    core: number;
};
const JLinkDeviceInfo = koffi.struct('DeviceInfo', {
    szStruct: 'uint32_t',
    sName: 'char *',
    coreId: 'uint32_t',
    flashAddr: 'uint32_t',
    ramAddr: 'uint32_t',
    endianMode: 'char',
    flashSize: 'uint32_t',
    ramSize: 'uint32_t',
    sManufacturer: 'char *',
    aFlashArea: koffi.array(JLinkFlashArea, 32),
    aRAMArea: koffi.array(JLinkRAMArea, 32),
    core: 'uint32_t',
});
const szJLinkDeviceInfo = koffi.sizeof(JLinkDeviceInfo);

export enum JLinkEmulatorInterfaceFlags {
    USB = 1 << 0,
    IP = 1 << 1,
    USB_AND_IP = USB | IP,
}

export enum JLinkDialogFlags {
    DLG_BUTTON_YES = 1 << 0,
    DLG_BUTTON_NO = 1 << 1,
    DLG_BUTTON_OK = 1 << 2,
    DLG_BUTTON_CANCEL = 1 << 3,
}

export enum JLinkTargetInterfaces {
    JTAG = 0,
    SWD = 1,
    FINE = 3,
    ICSP = 4,
    SPI = 5,
    C2 = 6,
}

export enum JLinkErrorCodes {
    UNSPECIFIED_ERROR = -1,
    EMU_NO_CONNECTION = -256,
    EMU_COMM_ERROR = -257,
    DLL_NOT_OPEN = -258,
    VCC_FAILURE = -259,
    INVALID_HANDLE = -260,
    NO_CPU_FOUND = -261,
    EMU_FEATURE_UNSUPPORTED = -262,
    EMU_NO_MEMORY = -263,
    TIF_STATUS_ERROR = -264,
    FLASH_PROG_COMPARE_FAILED = -265,
    FLASH_PROG_PROGRAM_FAILED = -266,
    FLASH_PROG_VERIFY_FAILED = -267,
    OPEN_FILE_FAILED = -268,
    UNKNOWN_FILE_FORMAT = -269,
    WRITE_TARGET_MEMORY_FAILED = -270,
    DEVICE_FEATURE_NOT_SUPPORTED = -271,
    WRONG_USER_CONFIG = -272,
    NO_TARGET_DEVICE_SELECTED = -273,
    CPU_IN_LOW_POWER_MODE = -274,
}

const JLinkSpeedAdaptive = 0xffff;
export type JLinkSpeed = number | 'auto' | 'adaptive';

export type JLinkLogPrototype = (message: string) => void;
const JLinkLogPrototype = koffi.proto('void LogProto(char *msg)');
export type JLinkUnsecureHookPrototype = (title: string, msg: string, flags: number) => number;
const JLinkUnsecureHookPrototype = koffi.proto('int UnsecureHookProto(char *title, char *msg, int flags)');

function convertWinStdCalls(def: string) {
    return def.replace(/\s*\[__stdcall\]\s*/g, os.platform() === 'win32' ? ' __stdcall ' : ' ');
}

const JLinkMethod = <F extends (...args: never[]) => unknown>(def: string) => {
    return (lib: koffi.IKoffiLib) => {
        return lib.func(convertWinStdCalls(def)) as (...args: Parameters<F>) => ReturnType<F>;
    };
};

const JLinkMethodOptional = <F extends (...args: never[]) => unknown>(def: string) => {
    return (lib: koffi.IKoffiLib) => {
        try {
            return lib.func(convertWinStdCalls(def)) as (...args: Parameters<F>) => ReturnType<F>;
        } catch (_err) {
            return undefined;
        }
    };
};

export const JLinkMethodFactories = {
    isOpen: JLinkMethod<() => number>('int JLINKARM_IsOpen()'),
    emuIsConnected: JLinkMethod<() => number>('int JLINKARM_EMU_IsConnected()'),
    isConnected: JLinkMethod<() => number>('int JLINKARM_IsConnected()'),
    enableLog: JLinkMethod<(handler: koffi.IKoffiRegisteredCallback | null) => void>(
        'void JLINKARM_EnableLog(LogProto *handler)',
    ),
    enableLogCom: JLinkMethod<(handler: koffi.IKoffiRegisteredCallback | null) => void>(
        'void JLINKARM_EnableLogCom(LogProto *handler)',
    ),
    setErrorOutHandler: JLinkMethod<(handler: koffi.IKoffiRegisteredCallback | null) => void>(
        'void JLINKARM_SetErrorOutHandler(LogProto *handler)',
    ),
    setWarnOutHandler: JLinkMethod<(handler: koffi.IKoffiRegisteredCallback | null) => void>(
        'void JLINKARM_SetWarnOutHandler(LogProto *handler)',
    ),
    emuGetNumDevices: JLinkMethod<() => number>('int JLINKARM_EMU_GetNumDevices()'),
    emuGetList: JLinkMethod<
        (interfaceMask: JLinkEmulatorInterfaceFlags, infos: JLinkConnectInfo[] | null, maxInfos: number) => number
    >('int JLINKARM_EMU_GetList(int interfaceMask, _Out_ ConnectInfo *infos, int maxInfos)'),
    deviceGetIndex: JLinkMethod<(deviceName: string) => number>('int JLINKARM_DEVICE_GetIndex(char *deviceName)'),
    deviceGetInfo: JLinkMethod<(index: number, deviceInfo: JLinkDeviceInfo | null) => number>(
        'int JLINKARM_DEVICE_GetInfo(int index, _Inout_ DeviceInfo *deviceInfo)',
    ),
    selectIP: JLinkMethod<(host: string, port: number) => number>('int JLINKARM_SelectIP(char *host, int port)'),
    selectIPBySN: JLinkMethod<(serialNumber: number) => void>('void JLINKARM_EMU_SelectIPBySN(int serialNumber)'),
    selectByUSBSN: JLinkMethod<(serialNumber: number) => number>('int JLINKARM_EMU_SelectByUSBSN(int serialNumber)'),
    selectUSB: JLinkMethod<(port: number) => number>('int JLINKARM_SelectUSB(int port)'),
    openEx: JLinkMethod<
        (
            logHandler: koffi.IKoffiRegisteredCallback | null,
            errorHandler: koffi.IKoffiRegisteredCallback | null,
        ) => string | null
    >('char *JLINKARM_OpenEx(LogProto *logHandler, LogProto *errorHandler)'),
    setHookUnsecureDialog: JLinkMethodOptional<(handler: koffi.IKoffiRegisteredCallback | null) => void>(
        'void [__stdcall] *JLINK_SetHookUnsecureDialog(UnsecureHookProto *handler)',
    ),
    close: JLinkMethod<() => void>('void JLINKARM_Close()'),
    tifSelect: JLinkMethod<(targetInterface: number) => number>('int JLINKARM_TIF_Select(int targetInterface)'),
    execCommand: JLinkMethod<(command: string, errorBuffer: [string], errorBufferLength: number) => number>(
        'int JLINKARM_ExecCommand(char *command, _Out_ char *errorBuffer, int errorBufferLength)',
    ),
    setSpeed: JLinkMethod<(speed: number) => void>('void JLINKARM_SetSpeed(int speed)'),
    connect: JLinkMethod<() => number>('int JLINKARM_Connect()'),
    setResetDelay: JLinkMethod<(delay: number) => void>('void JLINKARM_SetResetDelay(int delay)'),
    reset: JLinkMethod<() => number>('int JLINKARM_Reset()'),
    go: JLinkMethod<() => void>('void JLINKARM_Go()'),
    halt: JLinkMethod<() => boolean>('bool JLINKARM_Halt()'),
    isHalted: JLinkMethod<() => number>('int8_t JLINKARM_IsHalted()'),
    readMemEx: JLinkMethod<(address: number, bufferSize: number, buffer: Buffer, access: number) => number>(
        'int JLINKARM_ReadMemEx(uint32_t address, int bufferSize, _Out_ uint8_t *buffer, int access)',
    ),
    writeMemEx: JLinkMethod<(address: number, bufferSize: number, buffer: Buffer, access: number) => number>(
        'int JLINKARM_WriteMemEx(uint32_t address, int bufferSize, uint8_t *buffer, int access)',
    ),
    getRegisterList: JLinkMethod<(indices: number[], maxIndices: number) => number>(
        'int JLINKARM_GetRegisterList(_Out_ uint32_t *indices, int maxIndices)',
    ),
    getRegisterName: JLinkMethod<(index: number) => string>('char *JLINKARM_GetRegisterName(int index)'),
    readRegister: JLinkMethod<(index: number) => number>('uint32_t JLINKARM_ReadReg(int index)'),
    readRegisters: JLinkMethod<
        (indices: number[], values: number[], statuses: number[], numRegisters: number) => number
    >('int JLINKARM_ReadRegs(uint32_t *indices, _Out_ uint32_t *values, _Out_ uint8_t *statuses, int numRegisters)'),
    writeRegister: JLinkMethod<(index: number, value: number) => number>(
        'uint32_t JLINKARM_WriteReg(int index, uint32_t value)',
    ),
    writeRegisters: JLinkMethod<
        (indices: number[], values: number[], statuses: number[], numRegisters: number) => number
    >('int JLINKARM_ReadRegs(uint32_t *indices, uint32_t *values, _Out_ uint8_t *statuses, int numRegisters)'),
} as const;
export type JLinkMethods = {
    [key in keyof typeof JLinkMethodFactories]: ReturnType<(typeof JLinkMethodFactories)[key]>;
};

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

const rwBuffer = Buffer.allocUnsafeSlow(4).fill(0);

/**
 * J-Link exclusive session.
 */
export class JLink implements Disposable {
    library: koffi.IKoffiLib;
    methods: JLinkMethods;
    logHandler: JLinkLogPrototype | undefined;
    warnHandler: JLinkLogPrototype | undefined;
    errorHandler: JLinkLogPrototype | undefined;
    unsecureHook: JLinkUnsecureHookPrototype | undefined;
    endianness = os.endianness();
    private processExitListener: () => void;
    private logHandlerNative: koffi.IKoffiRegisteredCallback;
    private warnHandlerNative: koffi.IKoffiRegisteredCallback;
    private errorHandlerNative: koffi.IKoffiRegisteredCallback;
    private unsecureHookNative: koffi.IKoffiRegisteredCallback;
    private registerNameLookup: Record<string, number> = {};
    private openOptions: OpenOptions | undefined;
    private connectOptions: ConnectOptions | undefined;
    private deviceInfo: JLinkDeviceInfo | undefined;

    /**
     * @param libPath Path to the J-Link library. Auto-detected if omitted.
     */
    constructor(libPath?: string | string[]) {
        let library: koffi.IKoffiLib | undefined;
        if (typeof libPath === 'string') {
            library = koffi.load(libPath);
        } else {
            const libPaths = JLink.findLibrary();
            if (libPath !== undefined) {
                libPaths.unshift(...libPath);
            }
            const errors: unknown[] = [];
            for (const path of libPaths) {
                try {
                    library = koffi.load(path);
                    break;
                } catch (err) {
                    errors.push(err);
                }
            }
            if (!library) {
                throw new AggregateError(errors, 'Could not load JLink library.');
            }
        }
        this.library = library;
        const methods = {} as JLinkMethods;
        for (const [name, factory] of Object.entries(JLinkMethodFactories)) {
            (methods as Record<string, unknown>)[name] = factory(library);
        }
        this.methods = methods;
        this.logHandlerNative = koffi.register(
            ((msg) => this.logHandler?.(msg)) as JLinkLogPrototype,
            koffi.pointer(JLinkLogPrototype),
        );
        this.warnHandlerNative = koffi.register(
            ((msg) => this.warnHandler?.(msg)) as JLinkLogPrototype,
            koffi.pointer(JLinkLogPrototype),
        );
        this.errorHandlerNative = koffi.register(
            ((msg) => this.errorHandler?.(msg)) as JLinkLogPrototype,
            koffi.pointer(JLinkLogPrototype),
        );
        this.unsecureHookNative = koffi.register(
            ((title, msg, flags) =>
                this.unsecureHook?.(title, msg, flags) ?? JLinkDialogFlags.DLG_BUTTON_NO) as JLinkUnsecureHookPrototype,
            koffi.pointer(JLinkUnsecureHookPrototype),
        );

        this.processExitListener = () => {
            this[Symbol.dispose]();
        };
        process.on('exit', this.processExitListener);
    }

    private static findLibrary() {
        const platform = os.platform();
        if (platform === 'win32' || platform === 'cygwin') {
            return JLink.findLibraryWindows();
        }
        if (platform === 'linux') {
            return JLink.findLibraryLinux();
        }
        if (platform === 'darwin') {
            return JLink.findLibraryDarwin();
        }
        throw new Error(`Unsupported platform: ${platform}`);
    }

    private static findLibraryWindows() {
        const arch = os.arch();
        const is64Bit = arch === 'x64' || arch === 'arm64';
        const dllName = `${is64Bit ? 'JLink_x64' : 'JLinkARM'}.dll`;
        const root = 'C:\\';
        const programFilesDirs = readdirSync(root, { withFileTypes: true }).filter(
            (n) => n.isDirectory() && n.name.startsWith('Program Files'),
        );
        const seggerPath = programFilesDirs
            .map((p) => joinPath(root, p.name, 'SEGGER'))
            .filter((p) => existsSync(p) && statSync(p).isDirectory());
        const jlinkPath = seggerPath.flatMap((p) => {
            const children = readdirSync(p, { withFileTypes: true });
            return children.filter((n) => n.name.startsWith('JLink')).map((n) => joinPath(p, n.name));
        });
        const dllPath = jlinkPath.map((p) => joinPath(p, dllName)).filter((p) => existsSync(p) && statSync(p).isFile());
        return dllPath;
    }

    private static findLibraryLinux() {
        const seggerPath = '/opt/SEGGER';
        const objName = 'libjlinkarm';
        const versionPath = readdirSync(seggerPath, { withFileTypes: true })
            .filter((n) => n.isDirectory())
            .map((n) => joinPath(seggerPath, n.name));
        const objPath = versionPath.flatMap((p) => {
            const children = readdirSync(p, { withFileTypes: true });
            return children.filter((n) => n.isFile() && n.name.startsWith(objName)).map((n) => joinPath(p, n.name));
        });
        return objPath;
    }

    private static findLibraryDarwin(): string[] {
        throw new Error('Unsupported platform: darwin');
    }

    [Symbol.dispose](): void {
        process.removeListener('exit', this.processExitListener);
        this.close();
        koffi.unregister(this.logHandlerNative);
        koffi.unregister(this.warnHandlerNative);
        koffi.unregister(this.errorHandlerNative);
        koffi.unregister(this.unsecureHookNative);
        this.library.unload();
    }

    throwError(errorCode: number): never {
        throw new Error(`JLink Error: ${JLinkErrorCodes[errorCode] ?? 'Unknown'} (${errorCode})`);
    }

    /**
     * Get the number of connected emulators.
     */
    getEmulatorCount() {
        return this.methods.emuGetNumDevices();
    }

    /**
     * List all available emulators.
     * @param host Emulator interface flags. Defaults to USB.
     */
    listEmulators(host: JLinkEmulatorInterfaceFlags = JLinkEmulatorInterfaceFlags.USB) {
        const emulatorCount = this.methods.emuGetList(host, null, 0);
        if (emulatorCount < 0) this.throwError(emulatorCount);
        const infos = new Array<JLinkConnectInfo>(emulatorCount);
        const foundLength = this.methods.emuGetList(host, infos, emulatorCount);
        if (foundLength < 0) this.throwError(foundLength);
        return infos.slice(0, foundLength);
    }

    private getSupportedDeviceByIndex(index: number) {
        const device = { szStruct: szJLinkDeviceInfo } as JLinkDeviceInfo;
        this.methods.deviceGetInfo(index, device);
        for (let j = device.aFlashArea.length - 1; j >= 0; j--) {
            if (device.aFlashArea[j].addr === 0 && device.aFlashArea[j].size === 0) {
                device.aFlashArea.splice(j, 1);
            } else {
                break;
            }
        }
        for (let j = device.aRAMArea.length - 1; j >= 0; j--) {
            if (device.aRAMArea[j].addr === 0 && device.aRAMArea[j].size === 0) {
                device.aRAMArea.splice(j, 1);
            } else {
                break;
            }
        }
        return device;
    }

    /**
     * List all supported devices.
     * @returns Supported device information.
     */
    listSupportedDevices() {
        const deviceCount = this.methods.deviceGetInfo(-1, null);
        const devices = new Array<JLinkDeviceInfo>(deviceCount);
        for (let i = 0; i < deviceCount; i++) {
            devices[i] = this.getSupportedDeviceByIndex(i);
        }
        return devices;
    }

    /**
     * Get device info by name. Returns `undefined` if unsupported.
     * @param deviceName Device name.
     */
    getSupportedDevice(deviceName: string) {
        const index = this.methods.deviceGetIndex(deviceName);
        if (index < 0) {
            return undefined;
        }
        return this.getSupportedDeviceByIndex(index);
    }

    private openConnection() {
        const result = this.methods.openEx(this.logHandlerNative, this.errorHandlerNative);
        if (result) {
            throw new Error(result);
        }
        if (this.methods.setHookUnsecureDialog) {
            this.methods.setHookUnsecureDialog(this.unsecureHookNative);
        }
    }

    /**
     * Open a connection to the J-Link emulator. Supports method chaining.
     * @param options Connection options.
     */
    open(options?: OpenOptions) {
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
    executeCommand(command: string) {
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
    connect(deviceName: string, options?: ConnectOptions) {
        if (!this.methods.isOpen()) {
            this.open(options);
        }
        const tifSelectResult = this.methods.tifSelect(options?.targetInterface ?? JLinkTargetInterfaces.SWD);
        if (tifSelectResult !== 0) {
            this.throwError(tifSelectResult);
        }
        this.executeCommand(`Device = ${deviceName}`);
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
                this.throwError(connectResult);
            }
        }
        this.isHalted(); // Test whether it is connected
        this.deviceInfo = this.getSupportedDevice(deviceName);
        if (this.deviceInfo) {
            if (this.deviceInfo.endianMode === 0) {
                this.endianness = 'LE';
            } else if (this.deviceInfo.endianMode === 1) {
                this.endianness = 'BE';
            } else {
                this.endianness = os.endianness();
            }
        }
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
        this.connectOptions = {
            targetInterface: options?.targetInterface,
            speed: options?.speed,
        };
        return this;
    }

    /**
     * Reconnect to the target device using the previous configuration.
     */
    reconnect() {
        if (!this.openOptions || !this.connectOptions || !this.deviceInfo) {
            throw new Error('Could not find appropriate options for connecting');
        }
        const deviceName = this.deviceInfo.sName;
        const options = { ...this.openOptions, ...this.connectOptions };
        this.close();
        return this.connect(deviceName, options);
    }

    /**
     * Halt CPU execution. Returns whether the operation succeeded.
     */
    halt() {
        const failed = this.methods.halt();
        return !failed;
    }

    /**
     * Check if the CPU is halted.
     */
    isHalted() {
        const result = this.methods.isHalted();
        if (result < 0) {
            this.throwError(result);
        }
        return result > 0;
    }

    /**
     * Resume CPU execution.
     */
    resume() {
        this.methods.go();
    }

    /**
     * Wait for the CPU to halt.
     * @param timeout Timeout in ms. Defaults to 30000.
     */
    async waitUntilHalt(timeout: number = 30000) {
        const maxTime = Date.now() + timeout;
        while (!this.isHalted()) {
            if (Date.now() > maxTime) {
                throw new Error(`CPU is not halted after ${timeout} milliseconds.`);
            }
            await delay(5);
        }
    }

    /**
     * Reset the target device.
     * @param delay Reset delay in ms. Defaults to 0.
     */
    reset(delay: number = 0) {
        this.resetAndHalt(delay);
        this.resume();
    }

    /**
     * Reset and halt the target device.
     * @param delay Reset delay in ms. Defaults to 0.
     */
    resetAndHalt(delay: number = 0) {
        this.methods.setResetDelay(delay);

        const result = this.methods.reset();
        if (result < 0) {
            this.throwError(result);
        }
        return result > 0;
    }

    /**
     * Read memory from the target device.
     * @param address Memory address.
     * @param buffer Buffer to store the data.
     * @param access Access type. Defaults to 0.
     * @returns Bytes read.
     */
    readMemory(address: number, buffer: Buffer, access: number = 0) {
        const unitsRead = this.methods.readMemEx(address, buffer.length, buffer, access);
        if (unitsRead < 0) {
            this.throwError(unitsRead);
        }
        return unitsRead;
    }

    /**
     * Read memory and return a new buffer.
     * @param address Memory address.
     * @param bytes Bytes to read.
     * @returns Buffer containing the data.
     */
    readMemoryImmediate(address: number, bytes: number) {
        const buffer = Buffer.allocUnsafe(bytes);
        const unitsRead = this.readMemory(address, buffer);
        return buffer.subarray(0, unitsRead);
    }

    /**
     * Read an 8-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readMemoryUInt8(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readUInt8();
    }

    /**
     * Read an 8-bit signed integer from memory.
     * @param address Memory address.
     */
    readMemoryInt8(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readInt8();
    }

    /**
     * Read a 16-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readMemoryUInt16(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt16BE();
        }
        return rwBuffer.readUInt16LE();
    }

    /**
     * Read a 16-bit signed integer from memory.
     * @param address Memory address.
     */
    readMemoryInt16(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt16BE();
        }
        return rwBuffer.readInt16LE();
    }

    /**
     * Read a 32-bit unsigned integer from memory.
     * @param address Memory address.
     */
    readMemoryUInt32(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt32BE();
        }
        return rwBuffer.readUInt32LE();
    }

    /**
     * Read a 32-bit signed integer from memory.
     * @param address Memory address.
     */
    readMemoryInt32(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt32BE();
        }
        return rwBuffer.readInt32LE();
    }

    /**
     * Read a 32-bit float from memory.
     * @param address Memory address.
     */
    readMemoryFloat(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
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
    writeMemory(address: number, buffer: Buffer, access: number = 0) {
        const unitsWritten = this.methods.writeMemEx(address, buffer.length, buffer, access);
        if (unitsWritten < 0) {
            this.throwError(unitsWritten);
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
    writeMemoryImmediate(address: number, bytes: number, bufferFiller: (buf: Buffer) => void) {
        const buffer = Buffer.allocUnsafe(bytes);
        bufferFiller(buffer);
        const unitsWritten = this.methods.writeMemEx(address, bytes, buffer, 0);
        if (unitsWritten < 0) {
            this.throwError(unitsWritten);
        }
        return unitsWritten;
    }

    /**
     * Write an 8-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryUInt8(address: number, value: number) {
        rwBuffer.writeUInt8(value);
        this.writeMemory(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * Write an 8-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryInt8(address: number, value: number) {
        rwBuffer.writeInt8(value);
        this.writeMemory(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * Write a 16-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryUInt16(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeUInt16BE(value);
        } else {
            rwBuffer.writeUInt16LE(value);
        }
        this.writeMemory(address, rwBuffer.subarray(0, 2), 2);
    }

    /**
     * Write a 16-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryInt16(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeInt16BE(value);
        } else {
            rwBuffer.writeInt16LE(value);
        }
        this.writeMemory(address, rwBuffer.subarray(0, 2), 2);
    }

    /**
     * Write a 32-bit unsigned integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryUInt32(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeUInt32BE(value);
        } else {
            rwBuffer.writeUInt32LE(value);
        }
        this.writeMemory(address, rwBuffer.subarray(0, 4), 4);
    }

    /**
     * Write a 32-bit signed integer to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryInt32(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeInt32BE(value);
        } else {
            rwBuffer.writeInt32LE(value);
        }
        this.writeMemory(address, rwBuffer.subarray(0, 4), 4);
    }

    /**
     * Write a 32-bit float to memory.
     * @param address Memory address.
     * @param value Value to write.
     */
    writeMemoryFloat(address: number, value: number) {
        if (this.endianness === 'BE') {
            rwBuffer.writeFloatBE(value);
        } else {
            rwBuffer.writeFloatLE(value);
        }
        this.writeMemory(address, rwBuffer.subarray(0, 4), 4);
    }

    /**
     * Get all available register names.
     */
    getRegisters(): string[] {
        return Object.keys(this.registerNameLookup);
    }

    /**
     * Read a register value as 32-bit unsigned integer. Throws if CPU is running or register is invalid.
     * @param registerName Register name.
     */
    readRegister(registerName: string) {
        if (!this.isHalted()) {
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
    readRegisters<K extends string>(registers: K[]) {
        const result = {} as { [k in K]: number };
        for (let i = 0; i < registers.length; i++) {
            result[registers[i]] = this.readRegister(registers[i]);
        }
        return result;
    }

    /**
     * Read a register value as 32-bit signed integer.
     * @param registerName Register name.
     */
    readRegisterInt32(registerName: string) {
        return uint32ToSigned(this.readRegister(registerName));
    }

    /**
     * Read a register value as 32-bit float.
     * @param registerName Register name.
     */
    readRegisterFloat(registerName: string) {
        return uint32ToFloat(this.readRegister(registerName));
    }

    /**
     * Batch read register values. Throws if CPU is running or any register is invalid.
     * @param registers Register names.
     * @returns Map of register names to values.
     */
    readRegisterBatch<K extends string>(registers: K[]) {
        if (!this.isHalted()) {
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
            this.throwError(status);
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
    writeRegister(registerName: string, value: number) {
        if (!this.isHalted()) {
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
    writeRegisters(registers: Record<string, number>) {
        for (const [name, value] of Object.entries(registers)) {
            this.writeRegister(name, value);
        }
    }

    /**
     * Write an 32-bit signed integer value to a register.
     * @param registerName Register name.
     * @param value Value to write.
     */
    writeRegisterInt32(registerName: string, value: number) {
        this.writeRegister(registerName, int32ToUnsigned(value));
    }

    /**
     * Write a 32-bit float value to a register.
     * @param registerName Register name.
     * @param value Value to write.
     */
    writeRegisterFloat(registerName: string, value: number) {
        this.writeRegister(registerName, floatToUInt32(value));
    }

    /**
     * Batch write register values. Throws if CPU is running or any register is invalid.
     * @param registers Map of register names to values.
     */
    writeRegisterBatch(registers: Record<string, number>) {
        if (!this.isHalted()) {
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
            this.throwError(status);
        }
    }
}
