import { build } from 'esbuild';
import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('package.json', { encoding: 'utf8' }));
const version = process.env.TGT_RELEASE_VERSION;

// Build stamp — short git commit hash if available, otherwise 'dev'. Printed
// in the server-startup banner so operators can confirm which build is
// actually running on their FXServer (file caching, failed zip extraction,
// and wrong-directory deployments all produce "fix didn't apply" symptoms
// that this banner makes trivially diagnosable).
let buildStamp;
try {
  buildStamp = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  buildStamp = 'dev';
}

if (version) {
  packageJson.version = version.replace('v', '');
  writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
}

writeFileSync(
  '.yarn.installed',
  new Date().toLocaleString('en-AU', {
    timeZone: 'UTC',
    timeStyle: 'long',
    dateStyle: 'full',
  })
);

writeFileSync(
  'fxmanifest.lua',
  `fx_version 'cerulean'
game 'common'
use_experimental_fxv2_oal 'yes'
lua54 'yes'
node_version '22'

name '${packageJson.name}'
author '${packageJson.author}'
version '${packageJson.version}'
license '${packageJson.license}'
repository '${packageJson.repository.url}'
description '${packageJson.description}'

dependencies {
    '/server:12913',
}

client_script 'ui.lua'
server_script 'dist/index.js'

files {
	'web/build/index.html',
	'web/build/**/*'
}

ui_page 'web/build/index.html'

provide 'mysql-async'
provide 'ghmattimysql'

convar_category 'OxMySQL' {
	'Configuration',
	{
		{ 'Connection string', 'mysql_connection_string', 'CV_STRING', 'mysql://user:password@localhost/database' },
		{ 'Debug', 'mysql_debug', 'CV_BOOL', 'false' },
		{ 'Enable in-game UI', 'mysql_ui', 'CV_BOOL', 'false' },
		{ 'Slow query warning (ms)', 'mysql_slow_query_warning', 'CV_INT', '200' },
		{ 'Log buffer size', 'mysql_log_size', 'CV_INT', '100' },
		{ 'Version check', 'mysql_versioncheck', 'CV_INT', '1' },
		{ 'Transaction isolation level', 'mysql_transaction_isolation_level', 'CV_INT', '2' },
		{ 'Logger service', 'mysql_logger_service', 'CV_STRING', '' }
	}
}
`
);

mkdirSync('dist', { recursive: true });
// dist/package.json must match the esbuild `format` below. If `format` ever
// changes to 'esm', update this file or FXServer will fail to load the bundle.
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2));

const sharedConfig = {
  bundle: true,
  keepNames: true,
  dropLabels: ['DEV'],
  legalComments: 'inline',
  platform: 'node',
  target: ['node22'],
  format: 'cjs',
  logLevel: 'info',
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
};

build({
  ...sharedConfig,
  entryPoints: [`./src/fivem/index.ts`],
  outfile: `dist/index.js`,
});

build({
  ...sharedConfig,
  entryPoints: [`./src/worker/worker.ts`],
  outfile: `dist/worker.js`,
});
