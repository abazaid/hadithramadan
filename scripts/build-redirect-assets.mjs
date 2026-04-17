import fs from 'node:fs';
import path from 'node:path';
import redirects from '../src/data/redirects.mjs';
import manifest from '../src/data/blogger-manifest.mjs';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const REPORTS_DIR = path.join(ROOT, 'reports');
const NETLIFY_FILE = path.join(PUBLIC_DIR, '_redirects');
const VERCEL_FILE = path.join(ROOT, 'vercel.json');
const NGINX_FILE = path.join(DEPLOY_DIR, 'nginx-redirects.conf');
const APACHE_FILE = path.join(DEPLOY_DIR, 'apache-redirects.conf');
const REPORT_FILE = path.join(REPORTS_DIR, 'redirect-audit.json');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DEPLOY_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const normalizedEntries = normalizeEntries(redirects);

const manifestCollisions = findManifestCollisions(manifest);
const sourceDuplicates = findDuplicateSources(normalizedEntries);
const chains = findRedirectChains(normalizedEntries);
const loops = chains.filter((item) => item.hasLoop);
const chainDepthGt1 = chains.filter((item) => item.depth > 1);

const netlify = buildNetlifyRedirects(normalizedEntries);
const vercel = buildVercelRedirects(normalizedEntries);
const nginx = buildNginxRedirects(normalizedEntries);
const apache = buildApacheRedirects(normalizedEntries);

fs.writeFileSync(NETLIFY_FILE, netlify, 'utf8');
fs.writeFileSync(VERCEL_FILE, JSON.stringify(vercel, null, 2) + '\n', 'utf8');
fs.writeFileSync(NGINX_FILE, nginx, 'utf8');
fs.writeFileSync(APACHE_FILE, apache, 'utf8');

const report = {
  generatedAt: new Date().toISOString(),
  totalRedirects: normalizedEntries.length,
  issues: {
    sourceDuplicates,
    manifestCollisions,
    chainDepthGt1: chainDepthGt1.map((x) => x.path),
    loops: loops.map((x) => x.path),
  },
  platformFiles: {
    netlify: relativeFromRoot(NETLIFY_FILE),
    vercel: relativeFromRoot(VERCEL_FILE),
    nginx: relativeFromRoot(NGINX_FILE),
    apache: relativeFromRoot(APACHE_FILE),
  },
};

fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(`Built redirect assets for ${normalizedEntries.length} URLs.`);
if (manifestCollisions.length > 0 || sourceDuplicates.length > 0 || loops.length > 0 || chainDepthGt1.length > 0) {
  console.log(`Audit warnings saved to ${relativeFromRoot(REPORT_FILE)}.`);
}

function normalizeEntries(map) {
  return Object.entries(map)
    .map(([source, destination]) => ({
      source: normalizePath(source),
      destination: normalizePath(destination),
    }))
    .filter((x) => x.source && x.destination && x.source !== x.destination)
    .sort((a, b) => a.source.localeCompare(b.source));
}

function normalizePath(value) {
  if (!value) return '';
  let pathOnly = String(value).trim();
  if (!pathOnly) return '';
  if (!pathOnly.startsWith('/')) pathOnly = `/${pathOnly}`;
  const [pathname] = pathOnly.split('?');
  return pathname;
}

function encodePath(value) {
  return encodeURI(value).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function buildNetlifyRedirects(entries) {
  const lines = [];
  lines.push('# Auto-generated. Do not edit manually.');
  lines.push('# www -> non-www');
  lines.push('https://www.hadith-ramadan.com/*  https://hadith-ramadan.com/:splat  301!');
  lines.push('# Old URL -> New URL (301)');
  for (const item of entries) {
    lines.push(`${encodePath(item.source)}  ${encodePath(item.destination)}  301`);
  }
  return lines.join('\n') + '\n';
}

function buildVercelRedirects(entries) {
  const wwwRedirect = {
    source: '/:path*',
    has: [{ type: 'host', value: 'www.hadith-ramadan.com' }],
    destination: 'https://hadith-ramadan.com/:path*',
    permanent: true,
  };
  return {
    redirects: [
      wwwRedirect,
      ...entries.map((item) => ({
        source: encodePath(item.source),
        destination: encodePath(item.destination),
        permanent: true,
      })),
    ],
  };
}

function buildNginxRedirects(entries) {
  const lines = [];
  lines.push('# Auto-generated. Include inside server {} block.');
  lines.push('if ($host = "www.hadith-ramadan.com") { return 301 https://hadith-ramadan.com$request_uri; }');
  for (const item of entries) {
    const sourceRegex = '^' + escapeRegex(item.source) + '$';
    lines.push(`location ~ ${sourceRegex} { return 301 ${encodePath(item.destination)}; }`);
  }
  return lines.join('\n') + '\n';
}

function buildApacheRedirects(entries) {
  const lines = [];
  lines.push('# Auto-generated for Apache');
  lines.push('RewriteEngine On');
  lines.push('RewriteCond %{HTTP_HOST} ^www\\.hadith-ramadan\\.com [NC]');
  lines.push('RewriteRule ^(.*)$ https://hadith-ramadan.com/$1 [R=301,L]');
  for (const item of entries) {
    lines.push(`Redirect 301 ${encodePath(item.source)} ${encodePath(item.destination)}`);
  }
  return lines.join('\n') + '\n';
}

function findDuplicateSources(entries) {
  const counts = new Map();
  for (const item of entries) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([source]) => source);
}

function findManifestCollisions(items) {
  const byOldPath = new Map();
  for (const item of items) {
    if (!item.oldUrl || !item.canonicalSlug) continue;
    let oldPath = '';
    try {
      oldPath = normalizePath(new URL(item.oldUrl).pathname);
    } catch {
      continue;
    }
    const destination = normalizePath(`/${item.canonicalSlug}/`);
    const set = byOldPath.get(oldPath) ?? new Set();
    set.add(destination);
    byOldPath.set(oldPath, set);
  }
  const collisions = [];
  for (const [oldPath, dests] of byOldPath.entries()) {
    if (dests.size > 1) {
      collisions.push({
        oldPath,
        destinations: [...dests].sort(),
      });
    }
  }
  return collisions.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
}

function findRedirectChains(entries) {
  const map = new Map(entries.map((item) => [item.source, item.destination]));
  const result = [];
  for (const source of map.keys()) {
    const seen = new Set([source]);
    let current = source;
    let depth = 0;
    let hasLoop = false;
    while (map.has(current)) {
      const next = map.get(current);
      depth += 1;
      if (seen.has(next)) {
        hasLoop = true;
        break;
      }
      seen.add(next);
      current = next;
    }
    result.push({ path: source, depth, hasLoop });
  }
  return result;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativeFromRoot(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}
