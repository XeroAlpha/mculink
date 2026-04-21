import type EventEmitter from 'node:events';
import { platform as getOSPlatform } from 'node:os';
import koffi from 'koffi';

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
koffi.struct('ConnectInfo', {
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
export const szJLinkDeviceInfo = koffi.sizeof(JLinkDeviceInfo);

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
export const JLinkSpeedAdaptive = 0xffff;

export type JLinkSpeed = number | 'auto' | 'adaptive';

export type JLinkLogPrototype = (message: string) => void;
export const JLinkLogPrototype = koffi.proto('void LogProto(char *msg)');
export const JLinkLogDelegate = koffi.pointer(JLinkLogPrototype);

export type JLinkUnsecureHookPrototype = (title: string, msg: string, flags: number) => number;
export const JLinkUnsecureHookPrototype = koffi.proto('int UnsecureHookProto(char *title, char *msg, int flags)');
export const JLinkUnsecureHookDelegate = koffi.pointer(JLinkUnsecureHookPrototype);

function convertWinStdCalls(def: string) {
    return def.replace(/\s*\[__stdcall\]\s*/g, getOSPlatform() === 'win32' ? ' __stdcall ' : ' ');
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

export interface JLinkDialog {
    title: string;
    message: string;
    flags: number;
    result: number;
}

export interface JLinkNativeEvents {
    log: [message: string, level: 'info' | 'error'];
    unsecureHook: [dialog: JLinkDialog];
}

export interface JLinkDelegates {
    log: koffi.IKoffiRegisteredCallback;
    error: koffi.IKoffiRegisteredCallback;
    unsecureHook: koffi.IKoffiRegisteredCallback;
}

export function bindJLinkLibrary(library: koffi.IKoffiLib, target: EventEmitter<JLinkNativeEvents>) {
    const methods = {} as JLinkMethods;
    for (const [name, factory] of Object.entries(JLinkMethodFactories)) {
        (methods as Record<string, unknown>)[name] = factory(library);
    }
    const log = koffi.register(
        ((msg) => target.emit('log', msg, 'info')) satisfies JLinkLogPrototype,
        JLinkLogDelegate,
    );
    const error = koffi.register(
        ((msg) => target.emit('log', msg, 'error')) satisfies JLinkLogPrototype,
        JLinkLogDelegate,
    );
    const unsecureHook = koffi.register(
        ((title, msg, flags) => {
            const dialog = { title, message: msg, flags, result: JLinkDialogFlags.DLG_BUTTON_NO };
            target.emit('unsecureHook', dialog);
            return dialog.result;
        }) satisfies JLinkUnsecureHookPrototype,
        JLinkUnsecureHookDelegate,
    );
    const delegates = { log, error, unsecureHook };
    return { methods, delegates };
}

export function unbindJLinkLibrary(delegates: JLinkDelegates) {
    koffi.unregister(delegates.log);
    koffi.unregister(delegates.error);
    koffi.unregister(delegates.unsecureHook);
}

export function throwJLinkError(errorCode: number): never {
    throw new Error(`JLink Error: ${JLinkErrorCodes[errorCode] ?? 'Unknown'} (${errorCode})`);
}
