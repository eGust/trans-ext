import tsParser from '@typescript-eslint/parser';
import solid from 'eslint-plugin-solid';
import { defineConfig } from 'eslint/config';

export default defineConfig([
	{
		name: 'local-translate/ignores',
		ignores: ['dist/**', 'node_modules/**'],
	},
	{
		name: 'local-translate/linter-options',
		linterOptions: { reportUnusedDisableDirectives: 'error' },
	},
	{
		name: 'local-translate/solid',
		files: ['src/**/*.{ts,tsx}'],
		extends: [solid.configs['flat/typescript']],
		rules: {
			'solid/components-return-once': 'error',
			'solid/reactivity': 'error',
			'solid/event-handlers': 'error',
			'solid/imports': 'error',
			'solid/style-prop': 'error',
			'solid/no-react-deps': 'error',
			'solid/no-react-specific-props': 'error',
			'solid/self-closing-comp': 'error',
		},
		languageOptions: {
			parser: tsParser,
		},
	},
]);
