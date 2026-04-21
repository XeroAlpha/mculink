import { setTimeout as delay } from 'node:timers/promises';
import { type JLinkMethods, throwJLinkError } from './binding.js';

export class JLinkCPU {
    private methods: JLinkMethods;

    /** @hidden */
    constructor(methods: JLinkMethods) {
        this.methods = methods;
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
            throwJLinkError(result);
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
            throwJLinkError(result);
        }
        return result > 0;
    }
}
