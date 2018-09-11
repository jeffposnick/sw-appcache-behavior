import commonJS from 'rollup-plugin-commonjs';
import path from 'path';
import resolve from 'rollup-plugin-node-resolve';

const windowLibraryConfig = {
  input: path.join('src', 'window-runtime.mjs'),
  output: {
    file: path.join('build', 'window-runtime.js'),
    format: 'iife',
  },
  plugins: [
    resolve(),
    commonJS(),
  ],
};

const serviceWorkerLibraryConfig = {
  input: path.join('src', 'sw-runtime.mjs'),
  output: {
    file: path.join('build', 'sw-runtime.js'),
    format: 'iife',
    name: 'goog.appCacheBehavior',
  },
  plugins: [
    resolve(),
    commonJS(),
  ],
};

export default [
  serviceWorkerLibraryConfig,
  windowLibraryConfig,
];
