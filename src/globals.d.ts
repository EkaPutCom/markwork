// The few web-standard globals the core uses, which every runtime it runs on has (Node, the renderer's Chromium). Only
// these are declared, not Node's types: anything else the core needs from the runtime goes through the platform port
// (platform/index.ts), so a `node:` import or a Node global in the core fails this typecheck.

declare type TimerHandle = { readonly __timer: unique symbol };
declare function setTimeout(handler: () => void, ms?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle | undefined | null): void;
declare function setInterval(handler: () => void, ms?: number): TimerHandle;
declare function clearInterval(handle: TimerHandle | undefined | null): void;

declare class TextEncoder {
    encode(text?: string): Uint8Array;
}
declare class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean });
    decode(data?: Uint8Array | ArrayBuffer): string;
}
