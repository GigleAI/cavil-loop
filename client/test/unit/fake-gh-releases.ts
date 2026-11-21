// A stateful fake `gh` for the development-build scripts (GitHub#215 / #628): the release list, its
// assets with GitHub's upload states, tags, and the writes scripts/dev-release.mjs makes, kept in a
// JSON file (FAKE_GH_STATE). Shared by test/unit/dev-release.test.ts and the across-nights test in
// test/unit/dev-plan.test.ts, so the nightly plan and the publish step read one world.
// FAKE_GH_READONLY=1 = the plan's read-only token: drafts are not listed.

// The fake gh: just the calls the script makes, with GitHub's behaviour where it matters (a draft is
// a release whose tag does not exist yet; lists are pages of 100; releases have ids; deleting a
// release leaves its tag, which is a ref of its own). `afterDelete` changes the state right after a
// given release is deleted — someone editing the list while the clean-up runs.
export const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const f = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2);
st.calls.push(a.map((x) => (x.includes('/') && fs.existsSync(x) ? path.basename(x) : x)));
const save = () => fs.writeFileSync(f, JSON.stringify(st));
const fail = (what) => {
  const i = st.fail.indexOf(what);
  if (i < 0) return false;
  st.fail.splice(i, 1);
  return true;
};
const die = (m) => { save(); process.stderr.write(m + '\n'); process.exit(1); };
// the files: what follows the tag up to the first option
const files = (list) => { const i = list.findIndex((x) => x.startsWith('--')); return (i < 0 ? list : list.slice(0, i)).filter((x) => fs.existsSync(x)).map((x) => path.basename(x)); };
const find = (tag) => st.releases.find((r) => r.tag_name === tag);
const relPath = (p) => /^repos\/[^/]+\/[^/]+\/(.*)$/.exec(p)?.[1] ?? '';
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'DELETE') {
  const p = relPath(a[3]);
  let m;
  if ((m = /^releases\/(\d+)$/.exec(p))) {
    const r = st.releases.find((x) => x.id === Number(m[1]));
    if (!r) die('HTTP 404: Not Found');
    if (fail('delete:' + r.tag_name)) die('HTTP 500');
    st.releases = st.releases.filter((x) => x !== r);
    st.deleted.push(r.tag_name);
    for (const h of st.afterDelete?.[r.tag_name] ?? []) {
      if (h.add) st.releases.push(h.add);
      else Object.assign(st.releases.find((x) => x.tag_name === h.tag), h.set);
    }
    save();
    process.exit(0);
  }
  if ((m = /^git\/refs\/tags\/(.+)$/.exec(p))) {
    if (!st.tags.includes(m[1])) die('HTTP 422: Reference does not exist');
    if (fail('tagdel:' + m[1])) die('HTTP 500');
    st.tags = st.tags.filter((t) => t !== m[1]);
    st.tagsDeleted.push(m[1]);
    save();
    process.exit(0);
  }
  die('fake gh: unknown delete ' + p);
}
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'PATCH') {
  const m = /^releases\/(\d+)$/.exec(relPath(a[3]));
  const r = m && st.releases.find((x) => x.id === Number(m[1]));
  if (!r) die('HTTP 404: Not Found');
  if (fail('patch:' + r.tag_name)) die('HTTP 500');
  if (!fail('patch-noop:' + r.tag_name) && a.includes('draft=true')) r.draft = true;
  save();
  process.exit(0);
}
if (a[0] === 'api' && /^repos\/[^/]+\/[^/]+\/git\/ref\/tags\//.test(a[1])) {
  const t = relPath(a[1]).slice('git/ref/tags/'.length);
  if (fail('tagread:' + t)) die('HTTP 502: Bad Gateway');
  if (!st.tags.includes(t)) die('HTTP 404: Not Found');
  save();
  // an annotated tag is a ref to a tag object, not to a commit (st.tagType: { tag: 'tag' })
  process.stdout.write(JSON.stringify({ ref: 'refs/tags/' + t, object: { type: st.tagType?.[t] ?? 'commit', sha: st.tagSha?.[t] ?? st.sha } }));
  process.exit(0);
}
// the client/v* tag refs (scripts/dev-plan.mjs): pages of { ref, object }
if (a[0] === 'api' && a.some((x) => /\/git\/matching-refs\/tags\//.test(x))) {
  if (fail('tags')) die('HTTP 502: Bad Gateway');
  save();
  process.stdout.write(JSON.stringify([st.tags.filter((t) => t.startsWith('client/v')).map((t) => ({ ref: 'refs/tags/' + t, object: { type: st.tagType?.[t] ?? 'commit', sha: st.tagSha?.[t] ?? st.sha } }))]));
  process.exit(0);
}
if (a[0] === 'api') {
  st.lists = (st.lists ?? 0) + 1;
  if (fail('list') || fail('list#' + st.lists)) die('HTTP 502: Bad Gateway');
  // the list GitHub shows can change between two reads (an upload settling): { "<n>": { tag, assets } }
  const after = st.afterList?.[st.lists];
  if (after) find(after.tag).assets = after.assets;
  // GitHub lists drafts only to a token that can write (the nightly plan's token can only read)
  const seen = process.env.FAKE_GH_READONLY ? st.releases.filter((r) => r.draft === false) : st.releases;
  const pages = [];
  for (let i = 0; i < seen.length; i += 100) pages.push(seen.slice(i, i + 100));
  if (!pages.length) pages.push([]);
  save();
  process.stdout.write(JSON.stringify(pages));
  process.exit(0);
}
const tag = a[2];
if (a[1] === 'create') {
  if (find(tag)) die('a release with this tag already exists');
  const names = files(a.slice(3));
  if (fail('create')) die('HTTP 500');
  // GitHub records a publish time once a release is published (null for a draft never published)
  const r = { id: st.nextId++, tag_name: tag, draft: a.includes('--draft'), prerelease: a.includes('--prerelease'), published_at: a.includes('--draft') ? null : '2026-11-21T00:00:00Z', target_commitish: a[a.indexOf('--target') + 1], assets: [], body: fs.readFileSync(a[a.indexOf('--notes-file') + 1], 'utf8') };
  st.releases.unshift(r);
  // an asset the way GitHub lists it: uploaded with its size, or — an upload that failed — a placeholder
  // of the same name, state "starter", size 0 (GitHub#628 review round 2)
  const up = (name) => ({ name, state: 'uploaded', size: 10 });
  if (fail('create-partial')) { r.assets = names.slice(0, 1).map(up); die('upload failed: connection reset'); }
  if (fail('create-starter')) { r.assets = names.map((name, i) => (i === 0 ? { name, state: 'starter', size: 0 } : up(name))); die('upload failed: connection reset'); }
  r.assets = names.map(up);
  save();
  process.exit(0);
}
if (a[1] === 'upload') {
  const r = find(tag);
  if (!r) die('release not found');
  if (fail('upload')) die('HTTP 500');
  // --clobber deletes the same-named asset first; an upload that then fails leaves it gone
  if (fail('upload-partial')) {
    const first = files(a.slice(3))[0];
    r.assets = r.assets.filter((x) => x.name !== first);
    die('upload failed: connection reset');
  }
  // --clobber: a file of the same name is replaced, whatever state it was in
  for (const n of files(a.slice(3))) {
    r.assets = r.assets.filter((x) => x.name !== n);
    r.assets.push({ name: n, state: 'uploaded', size: 10 });
  }
  save();
  process.exit(0);
}
if (a[1] === 'edit') {
  const r = find(tag);
  if (!r) die('release not found');
  if (fail('edit')) die('HTTP 500');
  // GitHub answering "ok" to an edit that did not take
  if (fail('edit-noop')) { save(); process.exit(0); }
  if (a.includes('--draft=false')) { r.draft = false; if (!r.published_at) r.published_at = '2026-11-21T00:00:00Z'; if (!st.tags.includes(tag) && !(st.noTagOnPublish ?? []).includes(tag)) { st.tags.push(tag); st.tagSha = { [tag]: r.target_commitish, ...(st.tagSha ?? {}) }; } }
  if (a.includes('--draft=true')) r.draft = true;
  if (a.includes('--prerelease')) r.prerelease = true;
  save();
  process.exit(0);
}
die('fake gh: unknown call ' + a.join(' '));
`;
