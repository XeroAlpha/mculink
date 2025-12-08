// @ts-expect-error
import elf from 'node-elf-file';
// @ts-expect-error
import strtab from 'node-elf-file/lib/strtab.js';

interface ELFData {
    // partial
    file: ELFFileHeader;
    chunks: ELFChunk[];
    sections: ELFSectionHeader[];
}

interface ELFFileHeader {
    // partial
    e_shstrndx: bigint;
}

interface ELFSectionHeader {
    // partial
    sh_name: bigint;
    chunk_idx?: bigint;
    chunk_offset?: bigint;
    sh_size: bigint;
    sh_type: string;
}

interface ELFInfo {
    // partial
    chunks: ELFChunk[];
    sections: Record<string, ELFSection> & Record<'.symtab', ELFSymtabSection>;
    segments: ELFSegment[];
}

interface ELFChunk {
    size: bigint;
    data: Buffer;
}

interface ELFSection {
    address: bigint;
    align: bigint;
    chunk_idx?: bigint;
    chunk_offset?: bigint;
    entsize: bigint;
    flags: string[];
    info: bigint;
    link: string;
    size: bigint;
    type: string;
}

interface ELFSymtabSection extends ELFSection {
    symbols: {
        bind: string;
        name: string;
        shndx: bigint;
        size: bigint;
        type: string;
        value: bigint;
        visibility: string;
    }[];
}

interface ELFSegment {
    align: bigint;
    chunk_idx: bigint;
    chunk_offset: bigint;
    filesz: bigint;
    flags: bigint[];
    memsz: bigint;
    paddr: bigint;
    type: string;
    vaddr: bigint;
}

export function analyzeELF(elfRaw: Buffer) {
    const elfData = elf.parse(elfRaw) as ELFData;
    const elfInfo = elf.analyze(elfData) as ELFInfo;
    const strtabHeader = elfData.sections[Number(elfData.file.e_shstrndx)];
    const strings = strtab.parse({
        header: strtabHeader,
        chunk: elfData.chunks[Number(strtabHeader.chunk_idx)],
    });
    const sections: Record<string, Buffer[]> = {};
    for (const sectionInfo of elfData.sections) {
        const { sh_name, chunk_idx, chunk_offset, sh_size } = sectionInfo;
        const name = strtab.string(strings, sh_name);
        if (chunk_idx !== undefined && chunk_offset !== undefined) {
            const chunk = elfData.chunks[Number(chunk_idx)];
            const data = chunk.data.subarray(Number(chunk_offset), Number(chunk_offset + sh_size));
            if (!sections[name]) {
                sections[name] = [];
            }
            sections[name].push(data);
        }
    }
    const symbolAddresses = {} as Record<string, number>;
    const functionAddresses = {} as Record<string, number>;
    const variableAddresses = {} as Record<string, number>;
    for (const symbol of elfInfo.sections['.symtab'].symbols) {
        const addr = Number(symbol.value);
        symbolAddresses[symbol.name] = addr;
        if (symbol.value !== 0n) {
            if (symbol.type === 'STT_FUNC') {
                functionAddresses[symbol.name] = addr - 1;
            } else if (symbol.type === 'STT_OBJECT') {
                variableAddresses[symbol.name] = addr;
            }
        }
    }
    const memMappings: {
        memAddr: number;
        memSize: number;
        writeSize: number;
        data: Buffer;
    }[] = [];
    const loadedSegments = elfInfo.segments.filter((e) => e.type === 'PT_LOAD');
    for (const { chunk_idx, chunk_offset, filesz, vaddr, memsz } of loadedSegments) {
        const chunk = elfInfo.chunks[Number(chunk_idx)];
        memMappings.push({
            memAddr: Number(vaddr),
            memSize: Number(memsz),
            writeSize: Number(filesz),
            data: chunk.data.subarray(Number(chunk_offset), Number(chunk_offset + filesz)),
        });
    }
    return { sections, symbolAddresses, functionAddresses, variableAddresses, memMappings };
}
