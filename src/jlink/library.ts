import { existsSync, readdirSync, statSync } from 'node:fs';
import { arch as getOSArch, platform as getOSPlatform } from 'node:os';
import { join as joinPath } from 'node:path';
import koffi from 'koffi';

function findLibrary() {
    const platform = getOSPlatform();
    if (platform === 'win32' || platform === 'cygwin') {
        return findLibraryWindows();
    }
    if (platform === 'linux') {
        return findLibraryLinux();
    }
    if (platform === 'darwin') {
        return findLibraryDarwin();
    }
    throw new Error(`Unsupported platform: ${platform}`);
}

function findLibraryWindows() {
    const arch = getOSArch();
    const is64Bit = arch === 'x64' || arch === 'arm64';
    const dllName = `${is64Bit ? 'JLink_x64' : 'JLinkARM'}.dll`;
    const root = 'C:\\';
    const programFilesDirs = readdirSync(root, { withFileTypes: true }).filter(
        (n) => n.isDirectory() && n.name.startsWith('Program Files'),
    );
    const seggerPath = programFilesDirs
        .map((p) => joinPath(root, p.name, 'SEGGER'))
        .filter((p) => existsSync(p) && statSync(p).isDirectory());
    const jlinkPath = seggerPath.flatMap((p) => {
        const children = readdirSync(p, { withFileTypes: true });
        return children.filter((n) => n.name.startsWith('JLink')).map((n) => joinPath(p, n.name));
    });
    const dllPath = jlinkPath.map((p) => joinPath(p, dllName)).filter((p) => existsSync(p) && statSync(p).isFile());
    return dllPath;
}

function findLibraryLinux() {
    const seggerPath = '/opt/SEGGER';
    const objName = 'libjlinkarm';
    const versionPath = readdirSync(seggerPath, { withFileTypes: true })
        .filter((n) => n.isDirectory())
        .map((n) => joinPath(seggerPath, n.name));
    const objPath = versionPath.flatMap((p) => {
        const children = readdirSync(p, { withFileTypes: true });
        return children.filter((n) => n.isFile() && n.name.startsWith(objName)).map((n) => joinPath(p, n.name));
    });
    return objPath;
}

function findLibraryDarwin(): string[] {
    throw new Error('Unsupported platform: darwin');
}

export function loadJLinkLibrary(libPath?: string | string[]) {
    if (typeof libPath === 'string') {
        return koffi.load(libPath);
    } else {
        const libPaths = findLibrary();
        if (libPath !== undefined) {
            libPaths.unshift(...libPath);
        }
        const errors: unknown[] = [];
        for (const path of libPaths) {
            try {
                return koffi.load(path);
            } catch (err) {
                errors.push(err);
            }
        }
        throw new AggregateError(errors, 'Could not load JLink library.');
    }
}
