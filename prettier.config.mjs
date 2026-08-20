export default {
	useTabs: true,
	tabWidth: 4,
	singleQuote: true,
	printWidth: 90,
	trailingComma: 'all',
	arrowParens: 'avoid',
	overrides: [
		{
			files: ['*.md', '*.yml', '*.yaml', '*.json'],
			options: { useTabs: false, tabWidth: 2 },
		},
	],
};
