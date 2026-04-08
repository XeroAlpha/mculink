# MCULink

A type-safe FFI to call MCU code from your computer via J-Link.

Docs: https://xeroalpha.github.io/mculink/

> [!WARNING]
> This project is under active development. Expect breaking changes.

## Quick Start

Install:

```
npm i mculink
```

Write your MCU code:

```c
int __attribute((used)) get_gpio(int pin)
{
    // ...
}

char __attribute((used)) uart_send_buffer[256];
void __attribute((used)) uart_send(int len)
{
    // ...
}

void main()
{
    while (1);
}
```

> `__attribute((used))` prevents the compiler from stripping these symbols.

Flash the code to your MCU, then connect it to your PC via J-Link.

Call the MCU from Node.js:

```typescript
import { JLink, mcuCall } from 'mculink';
import { armCall, t } from 'mculink/armv6-m'; // Only ARMv6-M for now

const jlink = new JLink().connect(/* MCU model */);

const mcu = mcuCall(jlink, /* path to .axf file */)
    .define({
        // Names must match your MCU code exactly.
        get_gpio: armCall(t.int, t.int),
        uart_send: armCall(t.void, t.int),
        uart_send_buffer: t.arrayOf(t.uint8, 256)
    });

// Call get_gpio on the MCU.
const val = await mcu.get_gpio(pin1);

// Write to uart_send_buffer, then call uart_send.
mcu.uart_send_buffer[0] = 0xff;
mcu.uart_send_buffer[1] = 0x2c;
mcu.uart_send_buffer[2] = 0x1d;
await mcu.uart_send(3);
```

## Types

Full documentation: [MCUTypes](https://xeroalpha.github.io/mculink/classes/mculink_armv6-m.MCUTypes.html)

```typescript
import { type ToJs } from 'mculink';
import { t } from 'mculink/armv6-m';

// Primitives
t.void                                 // void    -> undefined
t.uint8                                // uint8_t -> number
t.int32                                // int32_t -> number
t.float                                // float   -> number
t.int64                                // int64_t -> bigint

// Arrays
t.arrayOf(t.uint8, 256)                // uint8_t [256]    -> number[]
t.arrayOf(t.arrayOf(t.int32, 16), 10)  // int32_t [10][16] -> number[][]
t.buffer(1024)                         // char [1024]      -> Buffer
t.typedArrayOf(Uint16Array, 128)       // uint16_t [128]   -> Uint16Array

// Structs and unions
t.struct('POSITION', {                 // struct POSITION {  -> {
    x: t.uint32,                       //   uint32_t x;            x: number,
    y: t.uint32,                       //   uint32_t y;            y: number
})                                     // }                  }
t.union('VALUE', {                     // union VALUE {      -> {
    u32: t.uint32,                     //   uint32_t u32;          u32: number,
    u8: t.arrayOf(t.uint8, 4)          //   uint8_t u8[4];         u8: number[]
})                                     // }                  }

// Pointers and references
const Vec = t.struct('Vec', { x: t.float, y: t.float });
type Vec = ToJs<Vec>;
t.pointerOf(Vec)                       // Vec *   -> MCUPointer (read/write address and value)
t.ref(Vec)                             // Vec *   -> Vec | null (auto-deref on read, auto-alloc on write)
t.ref.out(Vec)                         // Vec *   -> [Vec | undefined] (output param only)
t.ref.inout(Vec)                       // Vec *   -> [Vec] (input/output param only)

// Raw memory views
t.spanOf(64)                           // char [64] -> MCUSpan
t.spanOf()                             // char *    -> MCUSpan

// Enums and flags
t.enum('STATE', t.uint8, {             // uint8_t -> 'STATE_OK' | 'STATE_ERROR'
    STATE_OK: 0,
    STATE_ERROR: 1
})
t.flags('STATS', t.uint8, {            // uint8_t -> { RX_EMPTY: bool, RX_FULL: bool, ... }
    RX_EMPTY: 0x01,
    RX_FULL: 0x02,
    TX_EMPTY: 0x04,
    TX_FULL: 0x08
})

// Special
t.never                                // Function never returns
```

## Function Calls

MCULink implements the ARM calling convention so you can call MCU functions like normal JS functions.

```typescript
import type { InRef, InoutRef, OutRef } from 'mculink';
import { armCall, armComplexCall, t } from 'mculink/armv6-m';

// void set_port(int8_t)
armCall(t.void, t.int8)

// float sum(int, int, int, int, int)
armCall(t.float, t.int, t.int, t.int, t.int, t.int)

// uint32_t get_pixel(int x, int y)
armCall<(x: number, y: number) => number>(t.uint32, t.int, t.int)

// float magnitude(Vec vec)
armCall<(vec: Vec) => number>(t.float, Vec)

// float distance_between(Vec *a, Vec *b)
armCall<(a: InRef<Vec>, b: InRef<Vec>) => number>(t.float, t.ref(Vec), t.ref(Vec))

// void vector_minus(Vec *a, Vec b)  // *a is modified by the call
armCall<(a: InoutRef<Vec>, b: Vec) => number>(t.float, t.ref.inout(Vec), Vec)

// Vec vector_diff(Vec a, Vec b)
armComplexCall<(a: Vec, b: Vec) => Vec>(Vec, Vec, Vec)
armCall<(result: OutRef<Vec>, a: Vec, b: Vec) => void>(t.void, t.ref.out(Vec), Vec, Vec)  // Same thing, different call style
```

> [!WARNING]
> Function calls are experimental:
> - Calling a function pauses MCU execution. MCULink tries to restore the previous state afterward, but this isn't always perfect. Only call functions when the MCU is in a safe state (e.g. idle loop).
> - Only one function call at a time.
> - Interrupts during a call cause undefined behavior.

## Memory Operations

### Dynamic Views

MCULink reads MCU memory lazily. When you access a variable, it returns a dynamic view backed by a JavaScript Proxy — not a static copy.
Memory is only read when you access a specific field. Writes sync back to the MCU automatically.

```typescript
mcu.uart_send_buffer[0] = 0xff;
mcu.uart_send_buffer[0] // 0xff
```

Dynamic views are convenient but slow. For bulk operations, take a snapshot, modify it, then write it back:

```typescript
const value = mcu.snapshot(mcu.uart_send_buffer);
for (let i = 0; i < value.length; i++) {
    value[i] ^= 0xcc;
}
mcu.uart_send_buffer = value;
```

> Buffer and TypedArray are returned as static copies, not dynamic views.

### Symbols

Symbols are structured representations of named locations in MCU memory that carry complete type and structural information. They allow you to navigate complex nested data structures in a type-safe manner:

```typescript
const mcu = mcuCall(/* ... */).define({
    x_ptr: t.pointerOf(t.int),
    cursors: t.arrayOf(
        t.struct('Vec', { x: t.int, y: t.int }),
        16
    )
});

mcu.typeOf(mcu.symbols.cursors[15].x)  // t.int
```

Symbols are primarily used for locating memory addresses and navigating complex data structures.

### References

References are direct manipulation interfaces to specific memory addresses. They provide immediate read/write access and can be assigned to pointer-type variables:

```typescript
const ref = mcu.referenceOf(mcu.symbols.cursors[15].x);
ref.value === mcu.cursors[15].x   // true

mcu.x_ptr = ref;                  // x_ptr = &cursors[15].x;
```

### Utility Functions

These functions accept any value that represents an address: `string` (symbol name), `number` (raw address), dynamic views, `MCUSpan`, `MCUSymbol`, or `MCUReference`.

```typescript
mcu.addressOf('uart_send_buffer');                    // Get address by symbol name
mcu.read(0x20000000, t.arrayOf(t.int, 8))             // Read int[8] at a raw address
mcu.write(mcu.uart_send_buffer, t.buffer(8), buffer)  // Write bytes to a dynamic view
mcu.cast(span, Vec)                                   // Reinterpret a span as a typed dynamic view
mcu.bind('main', armCall(t.void))                     // Turn an MCU function into a callable JS function
```

### Heap Allocation

Allocate memory on the MCU heap:

```typescript
const buffer = mcu.new(t.arrayOf(t.uint8, 16));
buffer.value.fill(0);
// ...
buffer.free();
```

Or with explicit resource management:

```typescript
using buffer = mcu.new(...);
```

Reference types allocate stack space automatically during function calls.

> [!WARNING]
> MCULink uses `HEAP_BASE` and `HEAP_LIMIT` symbols to find the heap. Make sure they exist in your build.
> MCULink manages its own heap memory separately from `malloc`. Overlapping their memory spaces causes undefined behavior.

### Memory Spans

`MCUSpan` is a typed view over a region of MCU memory with bounds checking:

```typescript
const span = mcu.spanOf(mcu.uart_send_buffer);

span.slice(0, 128)                  // Sub-region
span.readBuffer()                   // Read as Buffer
span.writeBuffer(buffer)            // Write from Buffer
span.read(t.uint32, 0x04)           // Read a typed value at offset
span.write(t.uint8, 0xff, 0)        // Write a typed value at offset
span.cast(t.arrayOf(t.uint8, 128), 128)  // Reinterpret at offset
span.copyTo(anotherSpan);           // Copy data to another span
```

## Contributing

Contributions are welcome:

- Bug reports and feature requests
- Code fixes and new features
- Docs and examples
- Code reviews and discussions

## License

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details.
