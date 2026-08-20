export default [
	{
		files: ['**/*.js'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'commonjs',
			globals: {
				require: 'readonly',
				module: 'writable',
				process: 'readonly',
				console: 'readonly',
				Buffer: 'readonly',
				globalThis: 'readonly',
				setTimeout: 'readonly',
				fetch: 'readonly',
				URL: 'readonly',
			},
		},
		linterOptions: { reportUnusedDisableDirectives: true },
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'no-undef': 'error',
			'no-var': 'error',
			'prefer-const': 'error',
			eqeqeq: ['error', 'always'],
			curly: 'error',
			'no-console': 'off',
		},
	},
	{
		ignores: ['node_modules/', 'coverage/'],
	},
];
