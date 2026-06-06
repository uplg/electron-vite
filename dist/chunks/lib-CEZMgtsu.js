import colors from 'picocolors';
import { createLogger } from 'vite';
import { s as startElectron } from './lib-5f5XbHGG.js';
import { build } from './lib-DwbxCo6g.js';
import 'node:path';
import 'node:fs';
import 'node:url';
import 'node:module';
import 'esbuild';
import 'node:child_process';
import 'node:crypto';
import 'node:fs/promises';
import 'magic-string';
import 'node:os';
import '@babel/core';

async function preview(inlineConfig = {}, options) {
    if (!options.skipBuild) {
        await build(inlineConfig);
    }
    const logger = createLogger(inlineConfig.logLevel);
    startElectron(inlineConfig.root);
    logger.info(colors.green(`\nstarting electron app...\n`));
}

export { preview };
