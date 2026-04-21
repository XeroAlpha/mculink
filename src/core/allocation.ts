import { alignedCeil } from '../util/align.js';
import type { MCUContext } from './types.js';

/**
 * Heap allocation handle. Requires manual `free()` or `using` syntax.
 */
export interface MCUAllocation extends Disposable {
    /**
     * Memory address.
     */
    readonly address: number;
    /**
     * Memory size.
     */
    readonly size: number;
    /**
     * Memory alignment.
     */
    readonly align?: number;
    /**
     * Free the memory.
     */
    free(): void;
}

/**
 * Stack allocation handle. Automatically freed when function returns.
 */
export interface MCUAutoAllocation {
    /**
     * Memory address.
     */
    readonly address: number;
    /**
     * Memory size.
     */
    readonly size: number;
    /**
     * Memory alignment.
     */
    readonly align?: number;
    /**
     * Finalizer. Called automatically when freed.
     */
    finalize?: () => void;
}

export interface MCUFinalizer {
    finalize(): void;
}

/**
 * Memory allocator.
 */
export interface MCUAllocator {
    /**
     * Allocate memory from the stack.
     *
     * @param ctx Call context.
     * @param size Allocation size.
     * @param align Alignment.
     * @returns A new stack allocation handle, or `null` if allocation failed.
     */
    allocateAuto(ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null;

    /**
     * Allocate memory from the heap. Returns `null` without heap control or insufficient space.
     *
     * @param ctx Call context.
     * @param size Allocation size.
     * @param align Alignment.
     * @returns Heap allocation handle.
     */
    allocate(ctx: MCUContext, size: number, align?: number): MCUAllocation | null;

    /**
     * Grant control over the stack memory via a user-supplied pointer modification method.
     *
     * This method returns a **Reclaimer** function. The lifecycle proceeds in two stages:
     * 1. **Revoke:** Calling the Reclaimer revokes stack control and returns a **Finalizer**.
     *    - After this point, further stack allocations will fail.
     *    - Existing allocations remain valid.
     * 2. **Finalize:** Calling the Finalizer frees all stack-allocated memory.
     *
     * @param commit - A callback function used to modify the stack pointer.
     *   - To **allocate**: Pass `size` and `align`. Returns the starting address, or `null` if allocation failed.
     *   - To **inspect**: Omit arguments to retrieve the current stack pointer.
     * @returns A Reclaimer function that, when invoked, returns the Finalizer.
     */
    stackAccess(ctx: MCUContext, commit: (size?: number, align?: number) => number | null): () => MCUFinalizer;

    /**
     * Grant heap control. Heap control cannot be reclaimed.
     *
     * @param ctx Call context.
     * @param heapBase Heap starting address.
     * @param heapLimit Heap ending address. Defaults to infinity.
     */
    heapAccess(ctx: MCUContext, heapBase: number, heapLimit?: number): void;
}

export class DefaultAllocator implements MCUAllocator {
    protected allocations = new Set<MCUAllocation>();
    protected freeBlocks: [start: number, end: number][] = [];
    protected autoAllocations = new Set<MCUAutoAllocation>();
    protected commitStack?: (size?: number, align?: number) => number | null;
    allocateAuto(_ctx: MCUContext, size: number, align?: number): MCUAutoAllocation | null {
        const commitStack = this.commitStack;
        if (!commitStack) {
            return null;
        }
        const address = commitStack(size, align);
        if (address === null) {
            return null;
        }
        const alloc = { address, size, align };
        this.autoAllocations.add(alloc);
        return alloc;
    }
    allocate(_ctx: MCUContext, size: number, align?: number): MCUAllocation | null {
        if (this.freeBlocks.length === 0) {
            return null;
        }
        for (let i = 0; i < this.freeBlocks.length; i++) {
            const freeBlock = this.freeBlocks[i];
            const address = align !== undefined ? alignedCeil(freeBlock[0], align) : freeBlock[0];
            const endAddr = address + size;
            if (freeBlock[1] >= endAddr) {
                if (address > freeBlock[0]) {
                    this.freeBlocks.splice(i, 0, [freeBlock[0], address]);
                    i += 1;
                }
                freeBlock[0] = endAddr;
                if (this.freeBlocks.length > 1 && freeBlock[0] >= freeBlock[1]) {
                    this.freeBlocks.splice(i, 1);
                }
                const free = () => this.free(alloc, address, endAddr);
                const alloc = { address, size, align, free, [Symbol.dispose]: free };
                this.allocations.add(alloc);
                return alloc;
            }
        }
        return null;
    }
    protected free(alloc: MCUAllocation, address: number, endAddr: number) {
        if (!this.allocations.has(alloc)) {
            throw new Error(`Allocation is already freed.`);
        }
        this.allocations.delete(alloc);
        let inserted = false;
        for (let i = 0; i < this.freeBlocks.length; i++) {
            const freeBlock = this.freeBlocks[i];
            if (endAddr <= freeBlock[0]) {
                this.freeBlocks.splice(i, 0, [address, endAddr]);
                inserted = true;
            }
        }
        if (!inserted) {
            this.freeBlocks.push([address, endAddr]);
        }
        for (let i = 1; i < this.freeBlocks.length; i++) {
            const prev = this.freeBlocks[i - 1];
            const next = this.freeBlocks[i];
            if (prev[1] === next[0]) {
                prev[1] = next[1];
                this.freeBlocks.splice(i, 1);
                i -= 1;
            }
            if (prev[1] > next[0]) {
                throw new Error('Overlapping free blocks');
            }
        }
    }
    stackAccess(_ctx: MCUContext, commit: (size?: number, align?: number) => number | null): () => MCUFinalizer {
        if (this.commitStack) {
            throw new Error(`stackAccess is called twice.`);
        }
        this.commitStack = commit;
        return () => {
            this.commitStack = undefined;
            const allocs = [...this.autoAllocations];
            this.autoAllocations.clear();
            return {
                finalize() {
                    for (const alloc of allocs) {
                        alloc.finalize?.();
                    }
                },
            };
        };
    }
    heapAccess(_ctx: MCUContext, heapBase: number, heapLimit?: number): void {
        this.freeBlocks.push([heapBase, heapLimit ?? Infinity]);
    }
}
