declare module '*.xml?raw' {
    const xml: string;
    export default xml;
}
declare module '*.css';

// The version of package.json, put in by the build (scripts/electron-build.mjs).
declare const __APP_VERSION__: string;
