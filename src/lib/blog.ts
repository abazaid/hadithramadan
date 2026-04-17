import { getCollection, type CollectionEntry } from 'astro:content';

export async function getSortedPosts() {
	const posts = await getCollection('blog', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function getPostUrl(post: CollectionEntry<'blog'>) {
	return `/${post.data.canonicalSlug}/`;
}

export function slugifyLabel(label: string) {
	return label
		.normalize('NFKC')
		.trim()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.toLowerCase();
}

export function getLabelHref(label: string) {
	return `/topics/${slugifyLabel(label)}/`;
}

function normalizeForSearch(value: string) {
	return value
		.normalize('NFKC')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function tokenize(value: string) {
	const stopWords = new Set([
		'من',
		'في',
		'على',
		'عن',
		'الى',
		'إلى',
		'أن',
		'إن',
		'ما',
		'لا',
		'لم',
		'لن',
		'هذا',
		'هذه',
		'ذلك',
		'تلك',
		'و',
		'يا',
		'مع',
	]);
	return normalizeForSearch(value)
		.split(' ')
		.filter((token) => token.length > 2 && !stopWords.has(token));
}

export function getRelatedPosts(
	currentPost: CollectionEntry<'blog'>,
	allPosts: CollectionEntry<'blog'>[],
	limit = 10,
) {
	const currentLabels = new Set(currentPost.data.labels);
	const currentTokens = new Set(tokenize(`${currentPost.data.title} ${currentPost.data.description ?? ''}`));

	return allPosts
		.filter((post) => post.id !== currentPost.id)
		.map((post) => {
			const labelOverlap = post.data.labels.filter((label) => currentLabels.has(label)).length;
			const postTokens = tokenize(`${post.data.title} ${post.data.description ?? ''}`);
			const tokenOverlap = postTokens.filter((token) => currentTokens.has(token)).length;

			// Prioritize exact topical matches first, then semantic token overlap, then freshness.
			const freshnessBoost = Math.max(
				0,
				365 - (Date.now() - post.data.pubDate.valueOf()) / (1000 * 60 * 60 * 24),
			);
			const score = labelOverlap * 12 + tokenOverlap * 4 + freshnessBoost * 0.01;

			return { post, score };
		})
		.sort((a, b) => b.score - a.score || b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf())
		.slice(0, limit)
		.map(({ post }) => post);
}
