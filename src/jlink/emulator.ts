import { type JLinkConnectInfo, JLinkEmulatorInterfaceFlags, type JLinkMethods, throwJLinkError } from './binding.js';

/**
 * Emulator management.
 */
export class JLinkEmulators {
    private methods: JLinkMethods;

    /** @hidden */
    constructor(methods: JLinkMethods) {
        this.methods = methods;
    }

    /**
     * Get the number of connected emulators.
     */
    count() {
        return this.methods.emuGetNumDevices();
    }

    /**
     * List all available emulators.
     * @param host Emulator interface flags. Defaults to USB.
     */
    list(host: JLinkEmulatorInterfaceFlags = JLinkEmulatorInterfaceFlags.USB) {
        const emulatorCount = this.methods.emuGetList(host, null, 0);
        if (emulatorCount < 0) throwJLinkError(emulatorCount);
        const infos = new Array<JLinkConnectInfo>(emulatorCount);
        const foundLength = this.methods.emuGetList(host, infos, emulatorCount);
        if (foundLength < 0) throwJLinkError(foundLength);
        return infos.slice(0, foundLength);
    }
}
