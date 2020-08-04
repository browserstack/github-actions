module.exports = {
  env: {
    node: true,
    es2020: true,
  },
  extends: 'airbnb-base',
  parserOptions: {
    ecmaVersion: 11,
    sourceType: 'module',
  },
  rules: {
    semi: ['error', 'always'],
    indent: ['error', 2],
    quotes: ['warn', 'single'],
    'consistent-return': 'off',
  },
  ignorePatterns: ['dist/index.js'],
};
