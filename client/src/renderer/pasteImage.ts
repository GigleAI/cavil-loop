// GitHub#205 (maintainer's choice A): pasting an image into one of the app's text boxes.
// GitHub uploads a pasted image through the web page's signed-in session; there is no
// upload API a third-party app's credential can call (GitHub's REST / GraphQL docs list
// none), so the app cannot put the image on GitHub's image host. Instead of silently
// dropping it, the box says so and offers to carry on writing on the web page, where the
// image can be pasted.

/** A paste that carries an image and no text: the box would get nothing (a screenshot). */
export function isImageOnlyPaste(data: Pick<DataTransfer, 'items' | 'types'> | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types ?? []);
  if (types.includes('text/plain')) return false;
  return Array.from(data.items ?? []).some((i) => i.kind === 'file' && i.type.startsWith('image/'));
}

/** The web page for a new issue, with what was typed so far (GitHub reads title / body / labels from the address). */
export function newIssueOnWeb(web: string, repo: string, title: string, body: string, labels: string[]): string {
  const q = new URLSearchParams();
  if (title) q.set('title', title);
  if (body) q.set('body', body);
  if (labels.length) q.set('labels', labels.join(','));
  const s = q.toString();
  return `${web}/${repo}/issues/new${s ? `?${s}` : ''}`;
}

export const PASTE_IMAGE_NOTE = '客户端不能把图片上传到 GitHub（GitHub 没有给第三方程序的上传接口），这张图没有贴进来。';

/** Put the typed text on the clipboard for the web page; false when the system refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
