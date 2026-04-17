import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 900;

const cwd = process.cwd();
const astroCacheDir = path.join(cwd, '.astro');
const astroCliPath = path.join(cwd, 'node_modules', 'astro', 'bin', 'astro.mjs');

const problematicMarkers = ['UnknownFilesystemError', 'content-assets.mjs.tmp', 'ENOENT', 'EPERM'];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTransientFiles() {
	await mkdir(astroCacheDir, { recursive: true });
	await Promise.all([
		rm(path.join(astroCacheDir, 'content-assets.mjs.tmp'), { force: true }),
		rm(path.join(astroCacheDir, 'content-modules.mjs.tmp'), { force: true }),
	]);
}

function runAstroBuild() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [astroCliPath, 'build'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let combinedOutput = '';

		child.stdout.on('data', (chunk) => {
			const text = chunk.toString();
			combinedOutput += text;
			process.stdout.write(text);
		});

		child.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			combinedOutput += text;
			process.stderr.write(text);
		});

		child.on('close', (code) => {
			resolve({ code: code ?? 1, combinedOutput });
		});
	});
}

function isTransientFsError(output) {
	return problematicMarkers.every((marker) => output.includes(marker));
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
	await cleanupTransientFiles();
	const { code, combinedOutput } = await runAstroBuild();

	if (code === 0) {
		process.exit(0);
	}

	const shouldRetry = isTransientFsError(combinedOutput) && attempt < MAX_RETRIES;
	if (!shouldRetry) {
		process.exit(code);
	}

	console.warn(
		`[safe-build] retrying Astro build (${attempt}/${MAX_RETRIES - 1}) after transient filesystem error...`,
	);
	await sleep(RETRY_DELAY_MS);
}

process.exit(1);
