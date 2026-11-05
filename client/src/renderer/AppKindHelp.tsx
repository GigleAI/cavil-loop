// The "what is the difference" page behind the small link next to the sign-in
// choice (GigleAI/cavil-loop#140). Static text, no network; the facts live in
// shared/appKind.ts next to the permission line, so the two cannot disagree.
import { APP_KIND_ADVICE, APP_KIND_FACTS } from '../shared/appKind';

export function AppKindHelp({ onBack }: { onBack: () => void }) {
  return (
    <div className="help" data-testid="app-kind-help">
      <div className="toolbar">
        <button onClick={onBack} data-testid="help-back">
          ← 返回
        </button>
        <h2>OAuth 应用和 GitHub App 有什么不同</h2>
      </div>
      <div className="help-body">
        <p>
          两种都是用你的 GitHub 账号登录、以你本人的身份读写，能看到的永远不会超过你本人在 GitHub 上能看到的。
          区别在于：第一次用要谁点头、权限由谁定、能不能逐项限制。凭据过期与否看各自应用的设置，不由登录方式决定。
        </p>
        <table className="compare">
          <thead>
            <tr>
              <th></th>
              <th>OAuth 应用（默认）</th>
              <th>GitHub App</th>
            </tr>
          </thead>
          <tbody>
            {APP_KIND_FACTS.map((r) => (
              <tr key={r.topic}>
                <th>{r.topic}</th>
                <td>{r.oauth}</td>
                <td>{r.app}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>怎么选</h3>
        <ul>
          {APP_KIND_ADVICE.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <h3>两种方式都一样的地方</h3>
        <ul>
          <li>应用本身不会在你没操作时替你做事：这一版只读取看板数据，不改 GitHub 上的任何东西。</li>
          <li>凭据只存在这台电脑的钥匙串里，只发给 GitHub；退出登录会把它删掉。</li>
          <li>换登录方式只影响下一次登录，已经登录的账号照常使用，直到你退出。</li>
        </ul>
      </div>
    </div>
  );
}
