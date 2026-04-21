import { type JLinkDeviceInfo, type JLinkMethods, szJLinkDeviceInfo } from './binding.js';

export class JLinkDevices {
    private methods: JLinkMethods;

    /** @hidden */
    constructor(methods: JLinkMethods) {
        this.methods = methods;
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
    listSupported() {
        const deviceCount = this.methods.deviceGetInfo(-1, null);
        const devices = new Array<JLinkDeviceInfo>(deviceCount);
        for (let i = 0; i < deviceCount; i++) {
            devices[i] = this.getSupportedDeviceByIndex(i);
        }
        return devices;
    }

    /**
     * Find supported device info by name. Returns `undefined` if not found.
     * @param deviceName Device name.
     */
    findSupported(deviceName: string) {
        const index = this.methods.deviceGetIndex(deviceName);
        if (index < 0) {
            return undefined;
        }
        return this.getSupportedDeviceByIndex(index);
    }

    /**
     * Find supported device info by name. Throw if not found.
     * @param deviceName Device name.
     */
    findSupportedOrThrow(deviceName: string) {
        const deviceInfo = this.findSupported(deviceName);
        if (!deviceInfo) {
            throw new Error(`Device not found: ${deviceName}`);
        }
        return deviceInfo;
    }
}
