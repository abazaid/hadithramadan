import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BLOGGER_BLOGS_DIR = path.join(ROOT, 'Blogger', 'Blogs');
const CONTENT_DIR = path.join(ROOT, 'src', 'content', 'blog');
const DATA_DIR = path.join(ROOT, 'src', 'data');
const REDIRECTS_FILE = path.join(DATA_DIR, 'redirects.mjs');
const MANIFEST_FILE = path.join(DATA_DIR, 'blogger-manifest.mjs');
const SITE_URL = 'https://www.hadith-ramadan.com';
const RESERVED_SLUGS = new Set(['', 'blog', 'topics', 'about', 'rss.xml', '404', 'api']);
const MANUAL_REDIRECTS = {
	'/p/blog-page.html': '/books/',
};

const feedPath = findFeedPath(BLOGGER_BLOGS_DIR);

if (!feedPath) {
	console.log('No Blogger feed found. Skipping import.');
	process.exit(0);
}

const xml = fs.readFileSync(feedPath, 'utf8');
const posts = parsePosts(xml);

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
clearGeneratedContent(CONTENT_DIR);

const slugCounts = new Map();
const redirectMap = {};
const manifest = [];

for (const post of posts) {
	const baseSlug = slugifyArabic(post.title || post.filename || post.sourceId);
	const canonicalSlug = getUniqueSlug(baseSlug, slugCounts, post.sourceId);
	const filePath = path.join(CONTENT_DIR, `${canonicalSlug}.md`);
	const oldUrl = post.filename ? new URL(post.filename, SITE_URL).toString() : undefined;
	const cleanedContent = sanitizeHtml(post.content, post.title);
	const description = buildDescription({
		title: post.title,
		content: cleanedContent,
		labels: post.labels,
	});
	const frontmatter = [
		'---',
		`title: ${yamlString(post.title)}`,
		`description: ${yamlString(description)}`,
		`pubDate: ${post.published}`,
		post.updated ? `updatedDate: ${post.updated}` : null,
		`canonicalSlug: ${yamlString(canonicalSlug)}`,
		`sourceId: ${yamlString(post.sourceId)}`,
		oldUrl ? `oldUrl: ${yamlString(oldUrl)}` : null,
		post.labels.length > 0 ? `labels: [${post.labels.map(yamlString).join(', ')}]` : 'labels: []',
		'draft: false',
		'---',
		'',
		cleanedContent || `<p>${escapeHtml(description)}</p>`,
		'',
	]
		.filter(Boolean)
		.join('\n');

	fs.writeFileSync(filePath, frontmatter, 'utf8');

	if (post.filename) {
		redirectMap[post.filename] = `/${canonicalSlug}/`;
	}

	manifest.push({
		title: post.title,
		canonicalSlug,
		oldUrl,
		sourceId: post.sourceId,
		published: post.published,
		labels: post.labels,
	});
}

fs.writeFileSync(
	REDIRECTS_FILE,
	`const redirects = ${JSON.stringify({ ...redirectMap, ...MANUAL_REDIRECTS }, null, 2)};\n\nexport default redirects;\n`,
	'utf8',
);

fs.writeFileSync(
	MANIFEST_FILE,
	`const manifest = ${JSON.stringify(manifest, null, 2)};\n\nexport default manifest;\n`,
	'utf8',
);

console.log(`Imported ${manifest.length} live posts.`);

function findFeedPath(dir) {
	if (!fs.existsSync(dir)) {
		return null;
	}

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = findFeedPath(fullPath);
			if (nested) {
				return nested;
			}
		}
		if (entry.isFile() && entry.name === 'feed.atom') {
			return fullPath;
		}
	}

	return null;
}

function parsePosts(source) {
	return splitEntries(source)
		.map(parseEntry)
		.filter((entry) => entry && entry.type === 'POST' && entry.status === 'LIVE' && entry.title);
}

function splitEntries(source) {
	const matches = source.match(/<entry>[\s\S]*?<\/entry>/g);
	return matches ?? [];
}

function parseEntry(entryXml) {
	const type = getTag(entryXml, 'blogger:type');
	const status = getTag(entryXml, 'blogger:status') || 'LIVE';
	const title = normalizeText(decodeHtmlEntities(getTag(entryXml, 'title') || '').trim());
	const content = normalizeText(decodeHtmlEntities(getTagWithAttributes(entryXml, 'content') || '').trim());
	const published = getTag(entryXml, 'published');
	const updated = getTag(entryXml, 'updated');
	const filename = getTag(entryXml, 'blogger:filename') || '';
	const sourceId = (getTag(entryXml, 'id') || '').split('.post-').pop() || getTag(entryXml, 'id') || '';
	const labels = [...entryXml.matchAll(/<category\b[^>]*term='([^']+)'[^>]*\/>/g)].map((match) =>
		normalizeText(decodeHtmlEntities(match[1]).trim()),
	);

	return {
		type,
		status,
		title,
		content,
		published,
		updated,
		filename,
		sourceId,
		labels: Array.from(new Set(labels.filter(Boolean))),
	};
}

function getTag(source, tagName) {
	const match = source.match(new RegExp(`<${escapeRegex(tagName)}>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, 'u'));
	return match?.[1] ?? '';
}

function getTagWithAttributes(source, tagName) {
	const match = source.match(
		new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`, 'u'),
	);
	return match?.[1] ?? '';
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearGeneratedContent(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			fs.rmSync(fullPath, { recursive: true, force: true });
			continue;
		}
		if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
			// Keep book-imported posts so periodic Blogger sync doesn't wipe them.
			try {
				const head = fs.readFileSync(fullPath, 'utf8').slice(0, 2400);
				const sourceId = head.match(/^sourceId:\s*"(.*)"$/m)?.[1] ?? '';
				if (sourceId.startsWith('book-ramadan-')) {
					continue;
				}
			} catch {
				// Continue with deletion when file cannot be read/parsed.
			}
			fs.rmSync(fullPath, { force: true });
		}
	}
}

function sanitizeHtml(html, title) {
	if (!html?.trim()) {
		return '';
	}

	let output = html
		.replace(/\r\n?/g, '\n')
		.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<\?xml[\s\S]*?\?>/gi, ' ')
		.replace(/<\/?o:[^>]+>/gi, ' ')
		.replace(/<o:p>\s*<\/o:p>/gi, ' ')
		.replace(/<o:p>[\s\S]*?<\/o:p>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<xml[\s\S]*?<\/xml>/gi, ' ')
		.replace(/<(\/?)(html|body|head|meta|link)(\s[^>]*)?>/gi, ' ')
		.replace(/<br\b[^>]*\/?>/gi, '<br />')
		.replace(/&nbsp;/gi, ' ')
		.replace(/<span\b[^>]*>/gi, '')
		.replace(/<\/span>/gi, '')
		.replace(/<font\b[^>]*>/gi, '')
		.replace(/<\/font>/gi, '')
		.replace(/<div\b[^>]*>/gi, '<div>')
		.replace(/<p\b[^>]*>/gi, '<p>')
		.replace(/<h([1-6])\b[^>]*>/gi, '<h$1>')
		.replace(/<(table|tbody|thead|tfoot|tr|td|th|ul|ol|li|blockquote|a|img)\b[^>]*>/gi, (match, tag) =>
			preserveUsefulAttributes(match, tag),
		)
		.replace(/<(?!\/?(p|br|ul|ol|li|blockquote|strong|b|em|i|u|a|img|table|thead|tbody|tfoot|tr|th|td|h2|h3|h4)\b)[^>]+>/gi, ' ');

	output = output
		.replace(/<b>/gi, '<strong>')
		.replace(/<\/b>/gi, '</strong>')
		.replace(/<i>/gi, '<em>')
		.replace(/<\/i>/gi, '</em>')
		.replace(/<u>/gi, '<strong>')
		.replace(/<\/u>/gi, '</strong>')
		.replace(/<strong>\s*<strong>/gi, '<strong>')
		.replace(/<\/strong>\s*<\/strong>/gi, '</strong>')
		.replace(/<div>\s*/gi, '<p>')
		.replace(/\s*<\/div>/gi, '</p>')
		.replace(/<p>\s*(<br\s*\/?>|\s|&nbsp;)*<\/p>/gi, '')
		.replace(
			/<p>\s*(?:<strong>\s*)+[\d\s\-.)]*(?:<\/strong>\s*)+(?:\s*<strong>\s*)*([^<]{3,140}?)(?:[:：])?(?:\s*<\/strong>\s*)*<\/p>/gi,
			(_, text) => `<h2>${escapeHtml(cleanHeadingText(text))}</h2>`,
		)
		.replace(/<p>\s*<\/p>/gi, '');

	output = stripInlineAttributesFromTextTags(output);
	output = transformStandaloneParagraphs(output);
	output = normalizeHeadingHierarchy(output);
	output = elevateStructuredNumberedParagraphs(output);

	output = removeLeadingDuplicateTitleText(output, title);
	output = removeDuplicateTitleHeading(output, title);
	output = cleanTables(output);
	output = normalizeSpacing(output);

	return output.trim();
}

function transformStandaloneParagraphs(html) {
	return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
		const plain = cleanHeadingText(extractPlainText(inner));
		const words = plain.split(/\s+/u).filter(Boolean).length;

		if (!plain) {
			return '';
		}

		const numberedMatch = plain.match(/^(\d+)\s*[-.)]?\s*(.+?)[:：]?$/u);
		if (numberedMatch && numberedMatch[2].length <= 72 && words <= 10) {
			return `<h2>${escapeHtml(numberedMatch[2])}</h2>`;
		}

		const isMostlyStrong = /^(\s*<\/?strong>\s*)+/.test(inner) || /<strong>/.test(inner);
		if (isMostlyStrong && plain.length <= 72 && words <= 10 && /[:：]$/.test(plain)) {
			return `<h2>${escapeHtml(plain.replace(/[:：]+$/, '').trim())}</h2>`;
		}

		return `<p>${inner.trim()}</p>`;
	});
}

function normalizeHeadingHierarchy(html) {
	let seenH2 = false;
	return html
		.replace(/<h1>([\s\S]*?)<\/h1>/gi, '<h2>$1</h2>')
		.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/gi, (_match, levelText, inner) => {
			const level = Number(levelText);
			const plain = cleanHeadingText(extractPlainText(inner));
			const words = plain.split(/\s+/u).filter(Boolean).length;
			const isWeakHeading = !plain || plain.length < 3 || /^[\d٠-٩\s\-–—().:]+$/u.test(plain);
			if (isWeakHeading) {
				return `<p>${inner.trim()}</p>`;
			}
			const looksLikeParagraph = plain.length > 140 || words > 18 || (/[.،؛!?؟]/u.test(plain) && words > 12);
			if (looksLikeParagraph) {
				return `<p>${inner.trim()}</p>`;
			}
			if (level === 2) {
				seenH2 = true;
				return `<h2>${inner}</h2>`;
			}
			if (!seenH2) {
				seenH2 = true;
				return `<h2>${inner}</h2>`;
			}
			return `<h3>${inner}</h3>`;
		})
		.replace(/<h[2-4]>\s*<\/h[2-4]>/gi, '');
}

function elevateStructuredNumberedParagraphs(html) {
	return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
		const content = inner
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/&nbsp;/gi, ' ')
			.trim();
		const lines = content
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);

		if (lines.length < 2) {
			return match;
		}

		const firstLine = lines[0];
		const firstLineIsNumberOnly = /^[\p{N}]+\s*[.)-]\s*$/u.test(firstLine);
		const headingLine = firstLineIsNumberOnly ? lines[1] : firstLine;
		const headingCandidate = headingLine.replace(/^[\p{N}]+\s*[-.)]\s*/u, '').trim();
		const headingWords = headingCandidate.split(/\s+/u).filter(Boolean).length;

		const looksNumbered = /^[\p{N}]+\s*[-.)]/u.test(firstLine);
		const looksGoodHeading =
			headingCandidate.length >= 3 &&
			headingCandidate.length <= 90 &&
			headingWords >= 1 &&
			headingWords <= 14 &&
			!/^[\d٠-٩\s\-–—().:]+$/u.test(headingCandidate);

		if (!looksNumbered || !looksGoodHeading) {
			return match;
		}

		const bodyStartIndex = firstLineIsNumberOnly ? 2 : 1;
		const body = lines.slice(bodyStartIndex).join(' ').trim();
		if (!body || body.length < 20) {
			return match;
		}

		return `<h3>${escapeHtml(cleanHeadingText(headingCandidate))}</h3><p>${body}</p>`;
	});
}

function stripInlineAttributesFromTextTags(html) {
	return html
		.replace(/<(strong|em|i|u)\b[^>]*>/gi, '<$1>')
		.replace(/<(ul|ol|li|blockquote)\b[^>]*>/gi, '<$1>')
		.replace(/<(table|thead|tbody|tfoot|tr|th|td)\b[^>]*>/gi, '<$1>');
}

function preserveUsefulAttributes(match, tag) {
	const attributes = [];

	if (tag === 'a') {
		const href = match.match(/\shref=(['"])(.*?)\1/i)?.[2];
		if (href) {
			attributes.push(`href="${escapeAttribute(href)}"`);
		}
	}

	if (tag === 'img') {
		const src = match.match(/\ssrc=(['"])(.*?)\1/i)?.[2];
		const alt = match.match(/\salt=(['"])(.*?)\1/i)?.[2] ?? '';
		if (!src) {
			return '';
		}

		attributes.push(`src="${escapeAttribute(src)}"`, `alt="${escapeAttribute(alt)}"`, 'loading="lazy"');
	}

	return `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
}

function promoteHeadingParagraph(original, inner) {
	const text = cleanHeadingText(inner);
	if (!text) {
		return original;
	}

	if (text.length <= 85 && /[:：]$/.test(text)) {
		return `<h2>${escapeHtml(text.replace(/[:：]+$/, '').trim())}</h2>`;
	}

	return original;
}

function cleanHeadingText(value) {
	return value.replace(/[\u200e\u200f]/g, '').replace(/\s+/g, ' ').replace(/[\u00AD]+/g, '').trim();
}

function removeDuplicateTitleHeading(html, title) {
	if (!title) {
		return html;
	}

	const normalizedTitle = cleanHeadingText(title);
	return html.replace(/^\s*<(p|h2|h3|h4)>([\s\S]*?)<\/\1>/i, (match, _tag, text) => {
		const normalized = cleanHeadingText(extractPlainText(text));
		return normalized === normalizedTitle ? '' : match;
	});
}

function removeLeadingDuplicateTitleText(html, title) {
	if (!title) {
		return html;
	}

	const normalizedTitle = cleanHeadingText(title);
	const escaped = escapeRegex(normalizedTitle);
	return html.replace(new RegExp(`^\\s*${escaped}\\s*(?:<br\\s*\\/?>\\s*)*`, 'u'), '');
}

function cleanTables(html) {
	return html
		.replace(/<table>\s*<\/table>/gi, '')
		.replace(/<tr>\s*<\/tr>/gi, '')
		.replace(/<(td|th)>\s*<\/\1>/gi, '');
}

function normalizeSpacing(html) {
	return html
		.replace(/>\s+</g, '><')
		.replace(/(<\/(p|ul|ol|blockquote|table|h2|h3|h4)>)/gi, '$1\n')
		.replace(/(<(p|ul|ol|blockquote|table|h2|h3|h4)[^>]*>)/gi, '\n$1')
		.replace(/(<li[^>]*>)/gi, '\n$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function buildDescription({ title, content, labels }) {
	const plain = extractPlainText(content)
		.replace(new RegExp(`^${escapeRegex(title)}\\s*[:\\-–—]?\\s*`, 'u'), '')
		.trim();
	const topicHint = labels?.[0]?.trim();

	if (plain) {
		return truncate(plain, 165);
	}

	if (topicHint) {
		return `مقالة في ${topicHint} من مدونة الشيخ جواد عبد المحسن - حديث رمضان، تتناول قضايا إسلامية وسياسية واقتصادية بطرح فكري وتحليلي واضح.`;
	}

	return 'مقالة من مدونة الشيخ جواد عبد المحسن - حديث رمضان، تتناول قضايا إسلامية وسياسية واقتصادية بطرح فكري وتحليلي واضح.';
}

function extractPlainText(html) {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function truncate(value, maxLength) {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength - 3).trim()}...`;
}

function yamlString(value) {
	return JSON.stringify(value ?? '');
}

function slugifyArabic(value) {
	const slug = value
		.normalize('NFKC')
		.trim()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase();

	if (!slug || RESERVED_SLUGS.has(slug)) {
		return 'post';
	}

	return slug;
}

function getUniqueSlug(baseSlug, slugCounts, sourceId) {
	const count = slugCounts.get(baseSlug) ?? 0;
	slugCounts.set(baseSlug, count + 1);

	if (count === 0 && !RESERVED_SLUGS.has(baseSlug)) {
		return baseSlug;
	}

	return `${baseSlug}-${sourceId}`;
}

function decodeHtmlEntities(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function normalizeText(value) {
	if (!value) {
		return '';
	}
	let output = value.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n');
	output = fixMojibake(output);
	return output.normalize('NFKC');
}

function fixMojibake(value) {
	let current = value;
	for (let i = 0; i < 2; i += 1) {
		if (!looksLikeMojibake(current)) {
			break;
		}
		const repaired = Buffer.from(current, 'latin1').toString('utf8');
		if (arabicScore(repaired) <= arabicScore(current)) {
			break;
		}
		current = repaired;
	}
	return current;
}

function looksLikeMojibake(value) {
	return /[ØÙÃÂÐ]/.test(value);
}

function arabicScore(value) {
	const matches = value.match(/[\u0600-\u06FF]/g);
	return matches ? matches.length : 0;
}

function escapeHtml(value) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

