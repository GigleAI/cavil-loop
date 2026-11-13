// t() for a sentence with elements in it (GitHub#471): `tNode('已登录：{who}', { who: <b>{name}</b> })`.
// The sentence is translated as one key — word order differs between the languages — and each
// `{name}` is replaced by its element. A placeholder with no element stays as written, as in t().

import { Fragment, type ReactNode } from 'react';
import { getLang, translate } from '../shared/i18n';

export function tNode(zh: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  // the numbers among the values decide singular / plural, the elements are put in afterwards
  const counts: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(nodes)) if (typeof v === 'number') counts[k] = v;
  const text = translate(getLang(), zh, counts);
  const parts = text.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/);
  return (
    <>
      {parts.map((p, i) => {
        const name = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(p)?.[1];
        return <Fragment key={i}>{name !== undefined && Object.prototype.hasOwnProperty.call(nodes, name) ? nodes[name] : p}</Fragment>;
      })}
    </>
  );
}
