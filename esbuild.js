/* eslint-disable no-console */
const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info'
};

const run = async () => {
  if (isWatch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching for changes...');
    return;
  }

  await esbuild.build(options);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
