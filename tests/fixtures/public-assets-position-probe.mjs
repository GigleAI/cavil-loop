// tests/public-assets.test.sh 用：同一段假凭证放在文件里不同的位置，分块扫描的结论必须和
// 「整份读进来一次判」一样。用法：node public-assets-position-probe.mjs <仓库根> <临时目录>
// 每个场景打印一行 `<名字> whole=<0|1> stream=<0|1> unresolved=<0|1>`（1 = 判为含凭证；unresolved = 因超过上限而拒绝）。假凭证都是运行时拼出来的。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, dir] = process.argv.slice(2);
const rules = await import(pathToFileURL(path.join(root, 'scripts/public-assets/rules.mjs')));
const CHUNK = rules.SCAN_CHUNK_BYTES;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const filler = (n) => 'A'.repeat(n);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const longJwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'fake', claim: filler(8000) }), filler(43)].join('.');
const longField = `{"refresh` + `_token": "${filler(10000)}"}`;
const longDbUrl = 'postgres' + `://user:${filler(9000)}@db.example.invalid/x`;
const hugeJwt = [b64({ alg: 'HS256' }), 'eyJ' + filler(3 * CHUNK), filler(43)].join('.');

const cases = [];
for (const [what, secret] of [['jwt8k', longJwt], ['field10k', longField], ['dburl9k', longDbUrl]]) {
  // 起点相对读取块边界的位置：块内、刚好够旧的 4KB 重叠、不够、差一点、贴边、跨两块之后
  for (const start of [0, CHUNK - 12000, CHUNK - 5000, CHUNK - 4097, CHUNK - 300, CHUNK - 8, CHUNK, 3 * CHUNK - 5000]) {
    cases.push([`${what}@${start}`, start, secret, 1024]);
  }
}
cases.push(['jwt-longer-than-limit', CHUNK - 5000, hugeJwt, 1024]);
// 不该误拦的：长得像开头、但后面不成凭证
cases.push(['clean-eyJ-prefix-only', CHUNK - 40, 'eyJ' + filler(60) + ' not a token ', 2 * CHUNK]);
cases.push(['clean-word-in-prose', CHUNK - 6, 'the refresh' + '_token field is documented below. ', 2 * CHUNK]);
cases.push(['clean-postgres-no-password', CHUNK - 12, 'postgres' + '://localhost/db ' , 2 * CHUNK]);

for (const [name, start, secret, tail] of cases) {
  const data = Buffer.concat([PNG, Buffer.alloc(Math.max(0, start - PNG.length), 0x20), Buffer.from(secret, 'latin1'), Buffer.alloc(tail, 0x20)]);
  const file = path.join(dir, 'probe.png');
  fs.writeFileSync(file, data);
  const whole = rules.findSecrets(data.toString('latin1')).length ? 1 : 0;
  const kinds = rules.findSecretsInFile(file);
  const unresolved = rules.UNRESOLVED_KIND && kinds.includes(rules.UNRESOLVED_KIND) ? 1 : 0;
  console.log(`${name} whole=${whole} stream=${kinds.length ? 1 : 0} unresolved=${unresolved}`);
}
