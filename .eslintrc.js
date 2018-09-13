module.exports = {
  extends: ['eslint:recommended', 'google'],
  env: {
    serviceworker: true,
    browser: true,
    es6: true,
  },
  parserOptions: {
    ecmaVersion: 2017,
    sourceType: 'module',
  },
  rules: {
    'indent': ['error', 2],
  }
};
