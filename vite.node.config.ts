// The core's tests on Node: the same Vite bundling as vite.config.ts, for Node instead of GJS. Only node: built-ins are
// external, so a gi:// import that reaches the core fails the build instead of passing unnoticed.

import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: 'dist-node',
        emptyOutDir: true,
        target: 'node22',
        minify: false,
        sourcemap: false,
        ssr: true,
        lib: {
            entry: { 'run-core-node': 'tests/run-core-node.ts' },
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
        },
        rollupOptions: {
            external: [/^node:/],
            output: { chunkFileNames: 'chunks/[name].js' },
        },
    },
});
