export function alignedFloor(value: number, align: number) {
    return value - (value % align);
}

export function alignedCeil(value: number, align: number) {
    return alignedFloor(value + align - 1, align);
}
