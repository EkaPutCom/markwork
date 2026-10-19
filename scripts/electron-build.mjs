// Builds the Electron app into dist-electron/: main and core as ESM, the preload as CJS (a sandboxed preload cannot be
// ESM), and the renderer as one script next to its static files.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, readFile } from 'node:fs/promises';

const common = { configFile: false, logLevel: 'warn' };
const node = (entry, format, fileName, external) => build({
    ...common,
    build: {
        outDir: 'dist-electron', emptyOutDir: false, target: 'node22', minify: false, ssr: true,
        lib: { entry, formats: [format], fileName: () => fileName },
        rollupOptions: { external },
    },
});

await node('electron/main.ts', 'es', 'main.js', [/^node:/, 'electron']);
await node('electron/core.ts', 'es', 'core.js', [/^node:/]);
await node('electron/preload.ts', 'cjs', 'preload.cjs', ['electron']);
await build({
    ...common,
    plugins: [react()],
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(JSON.parse(await readFile('package.json', 'utf8')).version) },
    build: {
        outDir: 'dist-electron/renderer', emptyOutDir: true, target: 'chrome130', minify: false, cssCodeSplit: false,
        lib: { entry: 'electron/renderer/main.tsx', formats: ['iife'], name: 'markwork', fileName: () => 'renderer.js', cssFileName: 'renderer' },
    },
});
await cp('electron/renderer/index.html', 'dist-electron/renderer/index.html');
await cp('node_modules/mermaid/dist/mermaid.min.js', 'dist-electron/renderer/mermaid.min.js');
