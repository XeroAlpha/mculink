# MCULink

MCULink 是一个通过 J-Link 实现的，用于上位机与MCU通信的，类型安全的 FFI。

文档: https://xeroalpha.github.io/mculink/

> [!WARNING]
> 本项目仍在积极开发中。未来版本中可能出现不向后兼容的变更或移除。

## 示例

通过 NPM 安装 MCULink：

```
npm i mculink
```

编写单片机代码：

```c
int __attribute((used)) get_gpio(int pin)
{
    // ......
}

char __attribute((used)) uart_send_buffer[256];
void __attribute((used)) uart_send(int len)
{
    // ......
}

void main()
{
    while (1);
}
```

> `__attribute((used))` 用于防止编译器将这段代码错误当成“未被使用的代码”而移除。

将上述程序烧录到单片机后，用 J-Link 连接单片机和上位机电脑。

编写上位机代码：

```javascript
import { JLink, mcuCall } from 'mculink';
import { armCall, t } from 'mculink/armv6-m'; // 目前暂时只支持 ARMv6-M

const jlink = new JLink().connect(/* MCU 型号 */);

const mcu = mcuCall(jlink, /* 编译结果中 AXF 文件的路径。 */)
    .define({
        // 声明需要使用的函数与变量，名字需要和单片机代码中的完全一致。
        get_gpio: armCall(t.int, t.int),
        uart_send: armCall(t.void, t.int),
        uart_send_buffer: t.arrayOf(t.uint8, 256)
    });

// 调用单片机上的函数 get_gpio。
const val = await mcu.get_gpio(pin1);

// 调用单片机上的函数 uart_send。
mcu.uart_send_buffer[0] = 0xff;
mcu.uart_send_buffer[1] = 0x2c;
mcu.uart_send_buffer[2] = 0x1d;
await mcu.uart_send(3);
```

## 支持类型

```typescript
import { type ToJs } from 'mculink';
import { t } from 'mculink/armv6-m';

// 普通类型
t.void                                 // void    <-> undefined
t.uint8                                // uint8_t <-> number
t.int32                                // int32_t <-> number
t.float                                // float   <-> number
t.int64                                // int64_t <-> bigint

// 数组
t.arrayOf(t.uint8, 256)                // uint8_t [256]    <-> number[]
t.arrayOf(t.arrayOf(t.int32, 16), 10)  // int32_t [10][16] <-> number[][]
t.buffer(1024)                         // char [1024]      <-> Buffer
t.typedArrayOf(Uint16Array, 128)       // uint16_t [128]   <-> Uint16Array

// 结构与联合
t.struct('POSITON', {                  // struct POSITION {   <->  {
    x: t.uint32,                       //     uint32_t x;              x: number,
    y: t.uint32,                       //     uint32_t y;              y: number
})                                     // }                        }
t.union('VALUE', {                     // union VALUE {       <->  {
    u32: t.uint32,                     //     uint32_t u32;            u32: number,
    u8: t.arrayOf(t.uint8, 4)          //     uint8_t u8[4];           u8: number[]
})                                     // }                        }

// 指针与引用
const Vec = t.struct('Vec', { x: t.float, y: t.float });
type Vec = ToJs<Vec>;                  // typedef struct { float x; float y; } Vec;
// 通用指针，可以修改指针指向的地址与内容
t.pointerOf(Vec)                       // Vec * <-> MCUPointer<MCUTypeDef<Vec, {}>>
// 输入引用，读取时自动解引用，写入时自动分配内存
t.ref(t.uint32)                        // Vec * <-> Vec | null | undefined
// 输出引用，仅用于函数参数
t.ref.out(t.uint32)                    // Vec * <-> [Vec | undefined]
// 输入输出引用，仅用于函数参数
t.ref.inout(t.uint32)                  // Vec * <-> [Vec]

// 内存区域，对内存的直接访问
t.spanOf(64)                           // char [64] <-> MCUSpan
t.spanOf()                             // char *    <-> MCUSpan

// 枚举与标志
t.enum('STATE', t.uint8, {             // uint8_t <-> 'STATE_OK' | 'STATE_ERROR'
    STATE_OK: 0,
    STATE_ERROR: 1
})
t.flags('STATS', t.uint8, {            // uint8_t <-> {
    RX_EMPTY: 0x01,                    //                 RX_EMPTY: boolean, 
    RX_FULL: 0x02,                     //                 RX_FULL: boolean,
    TX_EMPTY: 0x04,                    //                 TX_EMPTY: boolean,
    TX_FULL: 0x08                      //                 TX_FULL: boolean
})                                     //             }

// 特殊类型
t.never                                // 仅用于函数返回值，表示函数不会返回
```

## 代理对象

MCULink 使用代理对象实现对 MCU 内存的按需实时透明访问。

当访问一个 MCU 变量时，MCULink 并不会立即读取整个结构体或数组，而是创建一个代理对象，在实际访问某个字段时才执行内存读取操作。开发者可以像操作普通 JS 对象一样读写其属性。当修改代理对象的属性时，变更会自动同步到 MCU 的内存中。

代理对象的读写速度较慢。如果需要快速读写，请使用 `mcu.snapshot()` 函数将代理对象转换为普通的 JavaScript 值，并在修改结束后赋值。

```typescript
const value = mcu.snapshot(mcu.uart_send_buffer);
for (let i = 0; i < value.length; i++) {
    value[i] ^= 0xcc;
}
mcu.uart_send_buffer = value;
```

> Buffer 与 TypedArray 不支持代理对象。

## 函数调用

MCULink 实现了 ARM 调用协定，提供了类型安全的远程函数调用能力。

开发者可以在上位机上像调用普通 JavaScript 函数一样调用 MCU 上的 C 函数，而无需关心底层的寄存器操作和内存管理细节。

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

// void vector_minus(Vec *a, Vec b)  // a 指向的值会在函数调用时改变
armCall<(a: InoutRef<Vec>, b: Vec) => number>(t.float, t.ref.inout(Vec), Vec)

// Vec vector_diff(Vec a, Vec b)
armComplexCall<(a: Vec, b: Vec) => Vec>(Vec, Vec, Vec)
armCall<(result: OutRef<Vec>, a: Vec, b: Vec) => void>(t.void, t.ref.out(Vec), Vec, Vec)  // 等效写法，但调用方式不同
```

> [!WARNING]
> 函数调用目前仍为实验性功能，部分情况下其功能会受到影响：
> - 当调用函数时，MCULink 会中断当前执行状态。函数返回后，MCULink 会尽可能恢复之前的执行状态。但受限于各种因素，部分执行状态无法恢复。推荐仅在确保 MCU 执行简单命令时（例如死循环）调用函数，否则可能导致不可预知的后果。
> - MCULink 不支持同一时间执行多个函数。试图进行这一操作可能导致不可预知的后果。
> - 在执行函数期间触发中断，进入中断处理函数会导致未知的结果。

## 内存操作

### 类型读写

MCULink 提供一系列工具函数，支持以指定的类型操作内存。

```typescript
// uart_send_buffer 的地址
mcu.addressOf('uart_send_buffer');

// uart_send_buffer 的类型定义
mcu.typeOf(mcu.symbols.uart_send_buffer)

// 读取位于 0x20000000 的 int[8]，返回一个快照后的对象 number[]
mcu.read(0x20000000, t.arrayOf(t.int, 8))

// 写入位于 uart_send_buffer 的 uint8_t[8]
mcu.write(mcu.uart_send_buffer, t.buffer(8), buffer)

// 将名为 span 的 MCUSpan，转换为一个代理对象 Vec
mcu.cast(span, Vec)

// 将位于 main 的函数代码，转换为对应的 JS 函数
mcu.bind('main', armCall(t.void))
```

### 符号与引用

符号是 MCU 内存中特定位置的标识符，它不仅代表一个地址，还携带完整的类型信息和层次结构信息。通过符号系统，你可以轻松定位复杂数据结构中的任意成员。

引用是对 MCU 内存中特定地址的直接操作接口，同时也是一个代理对象。通过引用，你可以直接读取或修改该地址的值。你还可以直接把引用类型赋值给指针类型的变量。

```typescript
const mcu = mcuCall(/* ... */).define({
    x_ptr: t.pointerOf(t.int),
    cursors: t.arrayOf(
        t.struct('Vec', {
            x: t.int,
            y: t.int
        }),
        16
    )
});

// x_ptr = &cursors[15].x;
mcu.x_ptr = mcu.referenceOf(mcu.symbols.cursors[15].x);
```

符号、引用和代理对象都包含了完整的地址信息。部分需要接收地址的函数也可以接收符号、引用和代理对象。

### 内存分配

MCULink 支持在 MCU 内存（堆）中动态分配一块区域，并返回一个对应类型的引用。

```typescript
const buffer = mcu.new(t.arrayOf(t.uint8, 16));
buffer.value.fill(0);

// ......

buffer.free();
```

除此以外，部分类型还会在调用函数时自动从栈上分配空间，并在调用结束后自动释放。

### 内存底层操作

MCULink 提供了 MCUSpan 类，可用于表示一段连续的 MCU 内存区域。它提供了安全的边界检查机制，允许开发者以安全的方式直接操作内存。MCUSpan 本身并不存储任何数据，而是作为 MCU 内存区域的代理，通过它可以访问 MCU 内存中的数据。

它支持以下操作：

```typescript
const span = mcu.spanOf(mcu.uart_send_buffer);

// 获取子区域。
span.slice(0, 128)

// 读写 Buffer
span.readBuffer()
span.writeBuffer(buffer)

// 读写内存中指定类型的值
span.read(t.uint32, 0x04)
span.write(t.uint8, 0xff, 0)
span.cast(t.arrayOf(t.uint8, 128), 128)

// 内存数据复制
span.copyTo(anotherSpan);
```

## 待定功能

- 可变参数：可能不会实现，因为函数工厂的类型定义无法实现该功能。
- 位域

## 贡献

我们欢迎任何形式的贡献，包括但不限于：

- 报告 bug 或提出功能建议
- 提交代码修复或新功能实现
- 改进文档或示例代码
- 参与社区讨论和技术评审

## 协议

本项目以 MIT License 开源。详见 [LICENSE](./LICENSE)。
