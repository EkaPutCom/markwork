// Builds the Electron app into dist-electron/: main and core as ESM, the preload as CJS (a sandboxed preload cannot be
// ESM), and the renderer as one script next to its static files.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const common = { configFile: false, logLevel: 'warn' };
const node = (entry, format, fileName, external) => build({
    ...common,
    build: {
        outDir: 'dist-electron', emptyOutDir: false, target: 'node22', minify: false, ssr: true,
        lib: { entry, formats: [format], fileName: () => fileName },
        rollupOptions: { external },
    },
});

await node('electron/main.ts', 'es', 'main.js', [/^node:/, 'electron', 'electron-updater']);
await node('electron/core.ts', 'es', 'core.js', [/^node:/]);
await node('electron/preload.ts', 'cjs', 'preload.cjs', ['electron']);
await build({
    ...common,
    // Tailwind for the shadcn/ui components; `@/` is the renderer's folder, as components.json names it.
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('../electron/renderer', import.meta.url)) } },
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(JSON.parse(await readFile('package.json', 'utf8')).version) },
    build: {
        outDir: 'dist-electron/renderer', emptyOutDir: true, target: 'chrome130', minify: false, cssCodeSplit: false,
        lib: { entry: 'electron/renderer/main.tsx', formats: ['iife'], name: 'markwork', fileName: () => 'renderer.js', cssFileName: 'renderer' },
    },
});
await cp('electron/renderer/index.html', 'dist-electron/renderer/index.html');
await cp('node_modules/mermaid/dist/mermaid.min.js', 'dist-electron/renderer/mermaid.min.js');

// The interface translations: each language of po/LINGUAS compiled to dist-electron/locale/<lang>/LC_MESSAGES/markwork.mo,
// the layout the core reads (platform/node/i18n.ts). msgfmt comes with gettext; with no language listed it is not needed.
const languages = (await readFile('po/LINGUAS', 'utf8')).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
await rm('dist-electron/locale', { recursive: true, force: true });
for (const lang of languages) {
    const out = `dist-electron/locale/${lang}/LC_MESSAGES`;
    await mkdir(out, { recursive: true });
    await promisify(execFile)('msgfmt', ['--check', '-o', `${out}/markwork.mo`, `po/${lang}.po`]);
}
