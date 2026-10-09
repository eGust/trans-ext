import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
	plugins: [solid()],
	base: './',
	build: {
		target: 'chrome138',
		outDir: 'dist',
		emptyOutDir: true,
		sourcemap: false,
		rollupOptions: {
			input: {
				popup: resolve(import.meta.dirname, 'popup.html'),
				selection: resolve(import.meta.dirname, 'selection.html'),
				options: resolve(import.meta.dirname, 'options.html'),
				background: resolve(import.meta.dirname, 'src/entrypoints/background.ts'),
			},
			output: {
				entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
			},
		},
	},
});
