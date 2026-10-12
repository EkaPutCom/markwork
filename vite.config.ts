// Vite is used as a bundler only (library mode): TypeScript → JavaScript, all
// modules are merged into an ESM file that GJS runs. The dev server and HMR are
// not used because this is a GTK app, not a web page.

import { copyFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

// Mermaid runs in WebKitGTK (see src/editor/mermaid.ts), so what is needed
// is its browser script file, not a module bundled into the GJS code.
const copyMermaid = (): Plugin => ({
    name: 'copy-mermaid',
    writeBundle(options) {
        copyFileSync('node_modules/mermaid/dist/mermaid.min.js', `${options.dir ?? 'dist'}/mermaid.min.js`);
    },
});

// The GSettings schema is compiled into dist/, where settings.ts looks for it at runtime.
const compileSchemas = (): Plugin => ({
    name: 'compile-gschemas',
    writeBundle(options) {
        const dir = options.dir ?? 'dist';
        copyFileSync('data/com.ekaput.Markwork.gschema.xml', `${dir}/com.ekaput.Markwork.gschema.xml`);
        execFileSync('glib-compile-schemas', ['--strict', dir]);
    },
});

// The app icon is copied to dist/icons so `npm start` still shows the icon without being installed;
// app.ts adds it to the icon theme search path. The installed version uses the system hicolor.
const copyIcons = (): Plugin => ({
    name: 'copy-icons',
    writeBundle(options) {
        cpSync('data/icons', `${options.dir ?? 'dist'}/icons`, { recursive: true });
    },
});

export default defineConfig({
    plugins: [copyMermaid(), compileSchemas(), copyIcons()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // GJS 1.80 uses SpiderMonkey 115 (equivalent to Firefox 115).
        target: 'firefox115',
        minify: false,
        sourcemap: false,
        lib: {
            entry: {
                markwork: 'src/main.ts',
                'run-tests': 'tests/run-tests.ts',
                capture: 'scripts/capture.ts',
                bench: 'tests/bench.ts',
                'bench-agentic': 'tests/bench-agentic.ts',
                'live-test': 'tests/live.ts',
                'live-forge': 'tests/live-forge.ts',
            },
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
        },
        rollupOptions: {
            // GJS built-in modules: provided at runtime, not from node_modules.
            external: [/^gi:\/\//, 'system', 'gettext', 'cairo', 'console'],
            output: {
                chunkFileNames: 'chunks/[name].js',
            },
        },
    },
});
