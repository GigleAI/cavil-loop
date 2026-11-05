// The "what is the difference" page behind the small link next to the sign-in
// choice (GigleAI/cavil-loop#140). Static text, no network.

const ROWS: { topic: string; oauth: string; app: string }[] = [
  {
    topic: '第一次用，要谁点头',
    oauth: '你在浏览器里点「授权」就行。只有组织开了「第三方应用访问限制」时，要组织管理员批准一次；批准前看不到这个组织的私有仓库和 Project。',
    app: '组织管理员（或仓库所有者）要先把这个 App 安装到组织、选好允许哪些仓库，然后你再点「授权」。',
  },
  {
    topic: '向你申请的权限',
    oauth: 'repo（你能访问的全部仓库读写，包括代码和设置）、read:org、project。GitHub 给 OAuth 应用的权限分得粗：要读私有仓库的 issue，就只能要整个 repo。',
    app: '只要 Issues、Pull requests、Projects 的读写，加仓库基本信息只读。看不到也改不了代码。',
  },
  {
    topic: '实际能看到哪些',
    oauth: '你本人在 GitHub 上能看到的全部。',
    app: '你本人能看到的，并且是这个 App 被安装到的那部分——两者都满足才行。',
  },
  {
    topic: '登录凭据多久过期',
    oauth: '不过期，直到你撤销。',
    app: '8 小时过期，本应用会自动续期；续期用的凭据约 6 个月不用就失效，到时重新登录。',
  },
  {
    topic: '凭据万一泄露',
    oauth: '拿到的人能以你的名义做 repo 权限范围内的一切（包括推代码），直到你撤销。',
    app: '只能动 issue、PR 和 Project。单拿到令牌，最多 8 小时就失效；连续期凭据一起拿到的话能一直续，直到你撤销。',
  },
  {
    topic: '怎么撤销',
    oauth: 'GitHub 网页 → 头像 → Settings → Applications → Authorized OAuth Apps。',
    app: 'GitHub 网页 → 头像 → Settings → Applications → Authorized GitHub Apps；组织管理员也可以直接卸载这个 App。',
  },
  {
    topic: '这一版的支持',
    oauth: '已内置，直接点「用 GitHub 登录」。',
    app: '预览：还没有内置的 GitHub App，要填你自己（或组织）建的 GitHub App 的 Client ID，并且那个 App 要勾上「Enable Device Flow」。',
  },
];

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
          区别在于：申请多大的权限、第一次用要谁点头、登录凭据多久过期。
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
            {ROWS.map((r) => (
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
          <li>大多数情况用默认的 OAuth 应用：不用等组织管理员安装，登录就能用。</li>
          <li>想把权限压到最小（不给代码权限、凭据会过期），或者组织不允许 OAuth 应用访问时，用 GitHub App。</li>
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
