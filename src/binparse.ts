export function alignedFloor(value: number, align: number) {
    return value - (value % align);
}

export function alignedCeil(value: number, align: number) {
    return alignedFloor(value + align - 1, align);
}

const rwBuffer = Buffer.allocUnsafeSlow(16).fill(0);

export function floatToUInt32(float: number) {
    rwBuffer.writeFloatLE(float);
    return rwBuffer.readUInt32LE();
}
export function uint32ToFloat(uint32: number) {
    rwBuffer.writeUInt32LE(uint32);
    return rwBuffer.readFloatLE();
}
export function int32ToUnsigned(int32: number) {
    rwBuffer.writeInt32LE(int32);
    return rwBuffer.readUInt32LE();
}
export function uint32ToSigned(uint32: number) {
    rwBuffer.writeUInt32LE(uint32);
    return rwBuffer.readInt32LE();
}
export function packUInt32ToUInt64(lo: number, hi: number) {
    rwBuffer.writeUInt32LE(lo, 0);
    rwBuffer.writeUInt32LE(hi, 4);
    return rwBuffer.readBigUInt64LE();
}
export function unpackUInt64ToUInt32(uint64: bigint) {
    rwBuffer.writeBigUInt64LE(uint64);
    return [rwBuffer.readUInt32LE(0), rwBuffer.readUInt32LE(4)];
}
export function packUInt32ToDouble(lo: number, hi: number) {
    rwBuffer.writeUInt32LE(lo, 0);
    rwBuffer.writeUInt32LE(hi, 4);
    return rwBuffer.readDoubleLE();
}
export function unpackDoubleToUInt32(double: number) {
    rwBuffer.writeDoubleLE(double);
    return [rwBuffer.readUInt32LE(0), rwBuffer.readUInt32LE(4)];
}
export function packUInt32ToInt64(lo: number, hi: number) {
    rwBuffer.writeUInt32LE(lo, 0);
    rwBuffer.writeUInt32LE(hi, 4);
    return rwBuffer.readBigInt64LE();
}
export function unpackUInt64ToInt32(int64: bigint) {
    rwBuffer.writeBigInt64LE(int64);
    return [rwBuffer.readUInt32LE(0), rwBuffer.readUInt32LE(4)];
}
