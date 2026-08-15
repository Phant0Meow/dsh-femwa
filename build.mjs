/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const clientOptions = {
  entryPoints: ['src/client.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-femwa",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
  // dsh-session must stay external: its runtime registry (registerSessionEventType)
  // is instance state shared with the host's persistence coordinator. Bundling a
  // copy would register into a private Set the coordinator never sees. The host
  // resolves this import to the same module instance (tsx tsconfig paths -> src).
  external: ['@deepseek-ai/dsh-session'],
};

if (watch) {
  await (await context(clientOptions)).watch();
  await (await context(hostOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  await Promise.all([build(clientOptions), build(hostOptions)]);
}
