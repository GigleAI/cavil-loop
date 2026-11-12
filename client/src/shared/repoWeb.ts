// The GitHub page of a repository (GitHub#398): the one place that builds the address the
// "open this repository on GitHub" buttons hand to the back end (board swimlane heads, the table's
// repository sections and its repository list).

/** `owner/name`, both parts in the characters GitHub allows; nothing else gets an address */
const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * `https://github.com/<owner>/<name>` for a repository name, or null when the text is not one
 * (the group of items without a repository, a group title, an empty string): no button then.
 */
export function repoWebUrl(repo: string | null | undefined): string | null {
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return null;
  const name = repo.slice(repo.indexOf('/') + 1);
  if (name === '.' || name === '..') return null;
  return `https://github.com/${repo}`;
}
