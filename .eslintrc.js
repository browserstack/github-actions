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
    indent: ['error', 2, { SwitchCase: 1 }],
    quotes: 'off',
    'consistent-return': 'off',
    'no-underscore-dangle': 'off',
    'no-case-declarations': 'error',
    'prefer-destructuring': ['error', { object: true, array: false }],
  },
  ignorePatterns: ['dist/index.js'],
};
