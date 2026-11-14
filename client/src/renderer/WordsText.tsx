// GitHub#473: the local daemon's messages in the window's language, the outside parts in them
// (a program's output, a path on this machine, a name the daemon's scripts gave) marked as shown as is.

import { getLang, readSaid, translate } from '../shared/i18n';
import type { Words } from '../shared/daemon';
import { SaidText, Verbatim } from './Verbatim';
import { Fragment } from 'react';

/** A sentence of the client's own words (shared/daemon.ts Words), its outside parts marked. */
export function WordsText({ words }: { words: Words }) {
  const outside = words.outside ?? {};
  const params = words.params ?? {};
  if (Object.keys(outside).length === 0) return <>{translate(getLang(), words.zh, params)}</>;
  // the own params filled in (they also decide singular / plural), the outside ones left as holes
  const own: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (!outside[k]) own[k] = v;
  const text = translate(getLang(), words.zh, own);
  return (
    <>
      {text.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/).map((p, i) => {
        const name = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(p)?.[1];
        const from = name === undefined ? undefined : outside[name];
        return from && name !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? (
          <Verbatim key={i} from={from}>
            {String(params[name])}
          </Verbatim>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </>
  );
}

/**
 * A message from the back end: drawn from its Said (its words, the outside parts marked) when one came,
 * otherwise the plain text (a message from before GitHub#473's fields, or one the window worded itself).
 */
export function BackendText({ said, text }: { said?: unknown; text: string | null | undefined }) {
  const s = readSaid(said);
  return s ? <SaidText said={s} /> : <>{text ?? ''}</>;
}
