module.exports = {
  env: {
    node: true,
    es2020: true,
    mocha: true,
  },
  extends: 'airbnb-base',
  parserOptions: {
    ecmaVersion: 11,
    sourceType: 'script',
  },
  rules: {
    semi: ['error', 'always'],
    indent: ['error', 2, { SwitchCase: 1 }],
    quotes: 'off',
    'consistent-return': 'off',
    'no-underscore-dangle': 'off',
    'no-case-declarations': 'error',
    'prefer-destructuring': ['error', { object: true, array: false }],
    'no-restricted-syntax': 'off',
    'linebreak-style': 'off',
    'no-plusplus': 'off',
  },
  ignorePatterns: ['dist/index.js'],
};
