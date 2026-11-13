// The one way text from outside reaches the screen as is (GitHub#466 / #471): GitHub content,
// the output of the local daemon's scripts, what a remote daemon sends back, an error message of
// git / the system / another program, and what the user typed or named on this machine. Its
// element carries `data-verbatim="<source>"`; the run-time language check lets Chinese through
// only inside such an element. Never put the client's own words in here — only the outside text.

import type { ReactNode } from 'react';
import { KEEP_LANG, type Lang, type VerbatimSource } from '../shared/i18n';
import { sourceLabel } from '../shared/sources';
import type { SourceConfig } from '../shared/types';
import { tNode } from './tNode';

export function Verbatim({ from, children, className, testid, title }: { from: VerbatimSource; children: ReactNode; className?: string; testid?: string; title?: string }) {
  return (
    <span data-verbatim={from} className={className} data-testid={testid} title={title}>
      {children}
    </span>
  );
}

/**
 * A hover text / label (`title`, `aria-label`) can hold no element, so text from outside inside it
 * cannot be wrapped: spread this onto the element instead, naming exactly the outside parts. The
 * language check takes those parts — and nothing else — out of the element's attributes.
 */
export function verbatimParts(from: VerbatimSource, parts: readonly (string | null | undefined)[]): Record<string, string> {
  return { 'data-verbatim-attr': from, 'data-verbatim-parts': JSON.stringify(parts.filter((p): p is string => typeof p === 'string' && p !== '')) };
}

/** A source's name as sourceLabel words it, its GitHub parts (Project title, owner, repository) shown as is. */
export function SourceName({ source: s, title }: { source: SourceConfig; title?: string }) {
  if (s.kind === 'repo') return <Verbatim from="github">{sourceLabel(s, title)}</Verbatim>;
  if (!title) return <>{sourceLabel(s, title)}</>;
  return <>{tNode('{title}（{owner} #{number}）', { title: <Verbatim from="github">{title}</Verbatim>, owner: <Verbatim from="github">{s.owner}</Verbatim>, number: s.number })}</>;
}

/** One of the few words that stay in their own language (KEEP_LANG): the language section naming itself. */
export function KeepLang({ text, testid }: { text: (typeof KEEP_LANG)[number]['text']; testid?: string }) {
  const lang: Lang = KEEP_LANG.find((k) => k.text === text)!.lang;
  return (
    <span lang={lang} data-keep-lang="" data-testid={testid}>
      {text}
    </span>
  );
}
