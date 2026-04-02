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
 * J-Link仿真器打开选项。
 */
export interface OpenOptions {
    host?: string;
    port?: number;
    serialNumber?: number;
}

/**
 * J-Link连接选项。
 */
export interface ConnectOptions extends OpenOptions {
    targetInterface?: JLinkTargetInterfaces;
    speed?: JLinkSpeed;
}

const rwBuffer = Buffer.allocUnsafeSlow(4).fill(0);

/**
 * J-Link独占会话。
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
     * 创建一个新的JLink实例。
     * @param libPath
     * J-Link库文件的路径，可以是字符串或字符串数组。
     * 如果未提供，将自动在系统中查找库文件。
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
     * 获取连接的仿真器数量。
     */
    getEmulatorCount() {
        return this.methods.emuGetNumDevices();
    }

    /**
     * 列出所有可用的仿真器。
     * @param host 仿真器接口标志，默认为USB。
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
     * 列出所有支持的设备。
     * @returns 支持的设备信息数组。
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
     * 获取指定设备的信息，如果设备不支持则返回undefined。
     * @param deviceName 设备名称。
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
     * 打开与J-Link仿真器的连接。支持链式调用。
     * @param options 连接选项。
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
     * 关闭与J-Link仿真器的连接。
     */
    close() {
        this.methods.close();
        this.openOptions = undefined;
        this.connectOptions = undefined;
    }

    /**
     * 执行J-Link命令并返回结果。
     * @param command 待执行的命令。
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
     * 连接至目标设备。支持链式调用。
     * @param deviceName 设备名称。
     * @param options 连接选项。
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
     * 以之前的配置重新连接到目标设备。
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
     * 暂停CPU执行。返回是否成功。
     */
    halt() {
        const failed = this.methods.halt();
        return !failed;
    }

    /**
     * 返回CPU是否处于暂停状态。
     */
    isHalted() {
        const result = this.methods.isHalted();
        if (result < 0) {
            this.throwError(result);
        }
        return result > 0;
    }

    /**
     * 恢复CPU执行。
     */
    resume() {
        this.methods.go();
    }

    /**
     * 等待CPU进入暂停状态。
     * @param timeout 等待超时时间（毫秒），默认30000毫秒
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
     * 重置目标设备。
     * @param delay 重置延迟时间（毫秒），默认为0
     */
    reset(delay: number = 0) {
        this.resetAndHalt(delay);
        this.resume();
    }

    /**
     * 重置并暂停目标设备。
     * @param delay 重置延迟时间（毫秒），默认为0
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
     * 从目标设备的指定内存地址读取数据到指定的缓冲区。
     * @param address 要读取的内存地址。
     * @param buffer 用于存储读取数据的缓冲区。
     * @param access 访问类型，默认为0。
     * @returns 实际读取的字节数。
     */
    readMemory(address: number, buffer: Buffer, access: number = 0) {
        const unitsRead = this.methods.readMemEx(address, buffer.length, buffer, access);
        if (unitsRead < 0) {
            this.throwError(unitsRead);
        }
        return unitsRead;
    }

    /**
     * 从目标设备的指定内存地址读取数据到新分配的缓冲区并返回该缓冲区。
     * @param address 要读取的内存地址。
     * @param bytes 要读取的最大字节数。
     * @returns 包含读取数据的缓冲区。
     */
    readMemoryImmediate(address: number, bytes: number) {
        const buffer = Buffer.allocUnsafe(bytes);
        const unitsRead = this.readMemory(address, buffer);
        return buffer.subarray(0, unitsRead);
    }

    /**
     * 从目标设备的指定内存地址读取一个8位无符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryUInt8(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readUInt8();
    }

    /**
     * 从目标设备的指定内存地址读取一个8位有符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryInt8(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 1), 1);
        return rwBuffer.readInt8();
    }

    /**
     * 从目标设备的指定内存地址读取一个16位无符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryUInt16(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt16BE();
        }
        return rwBuffer.readUInt16LE();
    }

    /**
     * 从目标设备的指定内存地址读取一个16位有符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryInt16(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 2), 2);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt16BE();
        }
        return rwBuffer.readInt16LE();
    }

    /**
     * 从目标设备的指定内存地址读取一个32位无符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryUInt32(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readUInt32BE();
        }
        return rwBuffer.readUInt32LE();
    }

    /**
     * 从目标设备的指定内存地址读取一个32位有符号整数。
     * @param address 要读取的内存地址。
     */
    readMemoryInt32(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readInt32BE();
        }
        return rwBuffer.readInt32LE();
    }

    /**
     * 从目标设备的指定内存地址读取一个32位浮点数。
     * @param address 要读取的内存地址。
     */
    readMemoryFloat(address: number) {
        this.readMemory(address, rwBuffer.subarray(0, 4), 4);
        if (this.endianness === 'BE') {
            return rwBuffer.readFloatBE();
        }
        return rwBuffer.readFloatLE();
    }

    /**
     * 向目标设备的指定内存地址写入缓冲区中的数据。
     * @param address 要写入的内存地址
     * @param buffer 包含要写入数据的缓冲区
     * @param access 访问类型，默认为0
     * @returns 实际写入的字节数
     * @throws 如果写入失败则抛出错误
     */
    writeMemory(address: number, buffer: Buffer, access: number = 0) {
        const unitsWritten = this.methods.writeMemEx(address, buffer.length, buffer, access);
        if (unitsWritten < 0) {
            this.throwError(unitsWritten);
        }
        return unitsWritten;
    }

    /**
     * 向目标设备的指定内存地址写入数据，在方法内部分配并填充缓冲区。
     * @param address 要写入的内存地址
     * @param bytes 要写入的字节数
     * @param bufferFiller 用于填充缓冲区的函数
     * @returns 实际写入的字节数
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
     * 向目标设备的指定内存地址写入一个8位无符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的8位无符号整数值。
     */
    writeMemoryUInt8(address: number, value: number) {
        rwBuffer.writeUInt8(value);
        this.writeMemory(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * 向目标设备的指定内存地址写入一个8位有符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的8位有符号整数值。
     */
    writeMemoryInt8(address: number, value: number) {
        rwBuffer.writeInt8(value);
        this.writeMemory(address, rwBuffer.subarray(0, 1), 1);
    }

    /**
     * 向目标设备的指定内存地址写入一个16位无符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的16位无符号整数值。
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
     * 向目标设备的指定内存地址写入一个16位有符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的16位有符号整数值。
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
     * 向目标设备的指定内存地址写入一个32位无符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的32位无符号整数值。
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
     * 向目标设备的指定内存地址写入一个32位有符号整数。
     * @param address 要写入的内存地址。
     * @param value 要写入的32位有符号整数值。
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
     * 向目标设备的指定内存地址写入一个32位浮点数。
     * @param address 要写入的内存地址。
     * @param value 要写入的32位浮点数值。
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
     * 获取目标设备上所有可用寄存器的名称列表。
     */
    getRegisters(): string[] {
        return Object.keys(this.registerNameLookup);
    }

    /**
     * 读取指定寄存器的值，以无符号32位整数形式返回。如果CPU正在运行或寄存器名称无效则抛出错误。
     * @param registerName 要读取的寄存器名称。
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
     * 读取一组指定寄存器的值，以无符号32位整数形式返回。
     * @param registers 要读取的寄存器名称数组。
     * @returns 包含寄存器名称和对应值的映射对象。
     */
    readRegisters<K extends string>(registers: K[]) {
        const result = {} as { [k in K]: number };
        for (let i = 0; i < registers.length; i++) {
            result[registers[i]] = this.readRegister(registers[i]);
        }
        return result;
    }

    /**
     * 读取指定寄存器的值，以有符号32位整数形式返回。
     * @param registerName 要读取的寄存器名称。
     */
    readRegisterInt32(registerName: string) {
        return uint32ToSigned(this.readRegister(registerName));
    }

    /**
     * 读取指定寄存器的值，以单精度浮点数形式返回。
     * @param registerName 要读取的寄存器名称
     */
    readRegisterFloat(registerName: string) {
        return uint32ToFloat(this.readRegister(registerName));
    }

    /**
     * 批量读取一组指定寄存器的值。如果CPU正在运行或任一寄存器名称无效则抛出错误。
     * @param registers 要读取的寄存器名称数组。
     * @returns 包含寄存器名称和对应值的映射对象。
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
     * 向指定寄存器写入一个无符号32位整数值。如果CPU正在运行或寄存器名称无效则抛出错误。
     * @param registerName 要写入的寄存器名称。
     * @param value 要写入的值。
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
     * 向多个寄存器写入指定的无符号32位整数值。
     * @param registers 包含寄存器名称和对应值的映射对象。
     */
    writeRegisters(registers: Record<string, number>) {
        for (const [name, value] of Object.entries(registers)) {
            this.writeRegister(name, value);
        }
    }

    /**
     * 向指定寄存器写入一个有符号32位整数值。
     * @param registerName 要写入的寄存器名称。
     * @param value 要写入的有符号整数值。
     */
    writeRegisterInt32(registerName: string, value: number) {
        this.writeRegister(registerName, int32ToUnsigned(value));
    }

    /**
     * 向指定寄存器写入一个单精度浮点数值。
     * @param registerName 要写入的寄存器名称。
     * @param value 要写入的浮点数值。
     */
    writeRegisterFloat(registerName: string, value: number) {
        this.writeRegister(registerName, floatToUInt32(value));
    }

    /**
     * 批量向一组寄存器写入值。如果CPU正在运行或任一寄存器名称无效则抛出错误。
     * @param registers 包含寄存器名称和对应值的映射对象。
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
