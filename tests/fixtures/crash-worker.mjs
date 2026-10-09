import { createApp } from '../../server.mjs';
import { Configuration } from '../../src/config.mjs';
import path from 'node:path';
const directory = process.argv[2]; const configuration = new Configuration(directory, { codexPath: 'fake', deepseekKey: 'fake', workspace: path.join(directory, 'workspace') }); configuration.resetStatus();
const providers = { close() {}, codex: { respond() {} }, run: async () => { process.stdout.write('CALL_STARTED\n'); return new Promise(() => {}); } };
const app = await createApp({ directory, configuration, providers, accountPolling: false, port: 0 }); const url = await app.listen();
process.stdout.write(JSON.stringify({ url }) + '\n');
