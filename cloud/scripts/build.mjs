import { access, cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = resolve(projectRoot, 'dist');
if (!distRoot.startsWith(`${projectRoot}\\`) && !distRoot.startsWith(`${projectRoot}/`)) throw new Error('Refusing to clean an unexpected build directory');

await rm(distRoot, { recursive: true, force: true });
await mkdir(resolve(distRoot, 'server'), { recursive: true });
await mkdir(resolve(distRoot, '.openai'), { recursive: true });
await cp(resolve(projectRoot, 'worker/index.js'), resolve(distRoot, 'server/index.js'));
await cp(resolve(projectRoot, 'worker/toolbox.js'), resolve(distRoot, 'server/toolbox.js'));
let hostingSource = resolve(projectRoot, '.openai/hosting.json');
try {
  await access(hostingSource);
} catch {
  hostingSource = resolve(projectRoot, '.openai/hosting.example.json');
  console.warn('Using hosting.example.json for source validation. Replace it with a real ignored hosting.json before deployment.');
}
await cp(hostingSource, resolve(distRoot, '.openai/hosting.json'));

console.log(`Built ${distRoot}`);
