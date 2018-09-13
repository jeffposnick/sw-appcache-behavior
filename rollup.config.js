import {terser} from 'rollup-plugin-terser';
import babel from 'rollup-plugin-babel';
import commonJS from 'rollup-plugin-commonjs';
import fse from 'fs-extra';
import path from 'path';
import resolve from 'rollup-plugin-node-resolve';

const banner = fse.readFile(path.join('templates', 'LICENSE-HEADER.txt'));

const windowLibraryConfig = {
  input: path.join('src', 'window-runtime.mjs'),
  output: {
    banner,
    file: path.join('build', 'window-runtime.js'),
    format: 'iife',
  },
  plugins: [
    resolve(),
    commonJS(),
    babel({runtimeHelpers: true}),
    terser(),
  ],
};

const serviceWorkerLibraryConfig = {
  input: path.join('src', 'sw-runtime.mjs'),
  output: {
    banner,
    file: path.join('build', 'sw-runtime.js'),
    format: 'iife',
    name: 'appcache',
  },
  plugins: [
    resolve(),
    commonJS(),
    babel({runtimeHelpers: true}),
    terser(),
  ],
};

export default [
  serviceWorkerLibraryConfig,
  windowLibraryConfig,
];
