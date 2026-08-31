#!/usr/bin/env python3
"""把 collect.py 的 JSON 渲染成两张趋势图（HTML→PNG）+ 周报 markdown。

用法：
    render.py --data data.json --out-dir OUT --asset-url-base URL --rev REV
              [--fonts-dir DIR]

产物：OUT/delivery-<rev>.png、OUT/effort-<rev>.png、OUT/report.md
（PNG 由 shot.mjs 截；本脚本只出 HTML，截图由 weekly-report.sh 串起来。）
"""
import argparse, datetime, json, os

INK="#232830"; MUT="#8a8580"; BG="#faf7f2"; GRID="#e6e0d6"
BLUE="#2a78d6"; ORANGE="#eb6834"; AQUA="#1baf7a"; GOLD="#c99332"; RED="#e34948"; VIO="#4a3aa7"

def esc(s): return str(s).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def fmt(v):
    """轴刻度 / 柱顶数字：>=1000 一律走 k，同一张图里格式才一致。"""
    v=float(v)
    if v>=1000:
        k=v/1000
        return f"{k:.0f}k" if abs(k-round(k))<0.05 else f"{k:.1f}k"
    return f"{v:.0f}"

def nice_max(v):
    """把轴上界抬到「好看的整数」，让 4 等分刻度不出现 48.3 / 24.1 这种碎数。"""
    import math
    if v <= 0:
        return 1
    v *= 1.12
    mag = 10 ** math.floor(math.log10(v))
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if v <= m * mag:
            return m * mag
    return 10 * mag

def lab(k):
    d=datetime.date.fromisoformat(k); return f"{d.month}/{d.day}"

class Chart:
    def __init__(self, weeks): self.weeks=weeks
    def panel(self,x0,y0,W,H,title,sub,series,note=None):
        WK=self.weeks; out=[]
        PL,PR,PT,PB=64,64,46,34
        ix,iy,iw,ih=x0+PL,y0+PT,W-PL-PR,H-PT-PB
        out.append(f'<text x="{x0+8}" y="{y0+18}" class="ttl">{esc(title)}</text>')
        out.append(f'<text x="{x0+8}" y="{y0+36}" class="sub">{esc(sub)}</text>')
        lv=[v for s in series if s["axis"]=="l" for v in s["data"] if v is not None]
        rv=[v for s in series if s["axis"]=="r" for v in s["data"] if v is not None]
        lmax=nice_max(max(lv+[1])); rmax=nice_max(max(rv+[1])) if rv else 1
        n=len(WK); step=iw/n
        yl=lambda v: iy+ih-(v/lmax)*ih
        yr=lambda v: iy+ih-(v/rmax)*ih
        for i in range(5):
            v=lmax*i/4; y=yl(v)
            out.append(f'<line x1="{ix}" y1="{y:.1f}" x2="{ix+iw}" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>')
            out.append(f'<text x="{ix-9}" y="{y+4:.1f}" class="ax" text-anchor="end">{fmt(v)}</text>')
        if rv:
            for i in range(5):
                v=rmax*i/4
                out.append(f'<text x="{ix+iw+9}" y="{yr(v)+4:.1f}" class="ax" text-anchor="start">{fmt(v)}</text>')
        for i,k in enumerate(WK):
            cls="axx last" if i==n-1 else "axx"
            out.append(f'<text x="{ix+step*i+step/2:.1f}" y="{iy+ih+20}" class="{cls}" text-anchor="middle">{lab(k)}</text>')
        bars=[s for s in series if s["type"]=="bar"]; bw=step*0.52
        if bars and bars[0].get("stack"):
            for i in range(n):
                base=0; cx=ix+step*i+step/2-bw/2
                for s in bars:
                    v=s["data"][i]; h=(v/lmax)*ih
                    out.append(f'<rect x="{cx:.1f}" y="{yl(base+v):.1f}" width="{bw:.1f}" height="{h:.1f}" fill="{s["color"]}"/>')
                    base+=v
                if base: out.append(f'<text x="{cx+bw/2:.1f}" y="{yl(base)-6:.1f}" class="val" text-anchor="middle" fill="{INK}">{fmt(base)}</text>')
        elif bars:
            s=bars[0]
            for i in range(n):
                v=s["data"][i]; cx=ix+step*i+step/2-bw/2
                out.append(f'<rect x="{cx:.1f}" y="{yl(v):.1f}" width="{bw:.1f}" height="{max((v/lmax)*ih,0):.1f}" fill="{s["color"]}" rx="2"/>')
                if v: out.append(f'<text x="{cx+bw/2:.1f}" y="{yl(v)-6:.1f}" class="val" text-anchor="middle" fill="{s["color"]}">{fmt(v)}</text>')
        for s in series:
            if s["type"]!="line": continue
            yy=yr if s["axis"]=="r" else yl
            seg=[]
            for i,v in enumerate(s["data"]):
                if v is None:
                    if len(seg)>1: out.append(f'<polyline points="{" ".join(seg)}" fill="none" stroke="{s["color"]}" stroke-width="2.4" stroke-linejoin="round"/>')
                    seg=[]; continue
                seg.append(f"{ix+step*i+step/2:.1f},{yy(v):.1f}")
            if len(seg)>1: out.append(f'<polyline points="{" ".join(seg)}" fill="none" stroke="{s["color"]}" stroke-width="2.4" stroke-linejoin="round"/>')
            for i,v in enumerate(s["data"]):
                if v is None: continue
                out.append(f'<circle cx="{ix+step*i+step/2:.1f}" cy="{yy(v):.1f}" r="3.4" fill="{BG}" stroke="{s["color"]}" stroke-width="2"/>')
        if note:
            idx,txt=note; mx=ix+step*idx
            out.append(f'<line x1="{mx:.1f}" y1="{iy-6}" x2="{mx:.1f}" y2="{iy+ih}" stroke="{RED}" stroke-width="1.4" stroke-dasharray="4 3"/>')
            out.append(f'<text x="{mx+6:.1f}" y="{iy+8}" class="note" fill="{RED}">{esc(txt)}</text>')
        lx=x0+W-PR; ly=y0+16
        for s in reversed(series):
            t=esc(s["label"]); lx-=len(t)*7.4+22
            if s["type"]=="bar": out.append(f'<rect x="{lx}" y="{ly-8}" width="11" height="11" fill="{s["color"]}" rx="2"/>')
            else: out.append(f'<line x1="{lx}" y1="{ly-3}" x2="{lx+12}" y2="{ly-3}" stroke="{s["color"]}" stroke-width="2.6"/>')
            out.append(f'<text x="{lx+16}" y="{ly+2}" class="leg">{t}</text>'); lx-=6
        return "".join(out)

def page(title_html, panels, H, fonts):
    ff=""
    if fonts and os.path.isdir(fonts):
        for fam,f,wt in (("LB","libre-baskerville-400-normal-latin.woff2",400),
                         ("LB","libre-baskerville-700-normal-latin.woff2",700),
                         ("SG","space-grotesk-500-normal-latin.woff2",500),
                         ("SG","space-grotesk-700-normal-latin.woff2",700)):
            p=os.path.join(fonts,f)
            if os.path.exists(p):
                ff+=f"@font-face{{font-family:'{fam}';src:url('file://{p}') format('woff2');font-weight:{wt}}}\n"
    css=ff+f"""
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:{BG};font-family:'SG','PingFang SC','Noto Sans SC',sans-serif;color:{INK};width:1280px}}
.wrap{{padding:30px 34px 22px}}
h1{{font-family:'LB',Georgia,serif;font-size:25px;font-weight:700;letter-spacing:-.2px}}
.lede{{font-size:13.5px;color:{MUT};margin-top:7px;line-height:1.6}}
svg{{display:block;margin-top:14px}}
.ttl{{font-family:'LB',Georgia,serif;font-size:15.5px;font-weight:700;fill:{INK}}}
.sub{{font-size:11.5px;fill:{MUT}}}
.ax{{font-size:10.5px;fill:{MUT}}}
.axx{{font-size:11px;fill:{MUT}}}
.axx.last{{fill:{GOLD};font-weight:700}}
.val{{font-size:10.5px;font-weight:700}}
.leg{{font-size:11.5px;fill:{INK}}}
.note{{font-size:11px;font-weight:700}}
"""
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head>'
            f'<body><div class="wrap">{title_html}'
            f'<svg width="1212" height="{H}" viewBox="0 0 1212 {H}">{"".join(panels)}</svg>'
            f'</div></body></html>')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data",required=True); ap.add_argument("--out-dir",required=True)
    ap.add_argument("--asset-url-base",required=True); ap.add_argument("--rev",required=True)
    ap.add_argument("--fonts-dir",default=None)
    a=ap.parse_args()
    D=json.load(open(a.data)); W=D["weeks"]; wk=D["weekly"]
    os.makedirs(a.out_dir,exist_ok=True)
    g=lambda f:[wk[k][f] for k in W]
    net=[wk[k]["add"]-wk[k]["del"] for k in W]
    kloc=[(wk[k]["cost"]/net[i]*1000 if net[i]>0 else None) for i,k in enumerate(W)]
    ch=Chart(W)
    tot=lambda f: sum(wk[k][f] for k in W)
    tnet=sum(net); prs=tot("pr_merged")
    lines_per_pr=(tnet/prs) if prs else 0
    t1=(f'<h1>最近 {len(W)} 周趋势 · 交付面（{lab(W[0])} ~ {lab(D["target_week"]["end"])}）</h1>'
        f'<div class="lede">{len(W)} 周合计：新提 issue <b>{tot("iss_open"):.0f}</b> 个、关闭 <b>{tot("iss_closed"):.0f}</b> 个，'
        f'合并 PR <b>{prs:.0f}</b> 个，主干净增 <b>{tnet:,.0f}</b> 行代码（平均每个 PR {lines_per_pr:,.0f} 行）。</div>')
    p1=ch.panel(0,0,1212,320,"交付节奏：合并的 PR 数 vs 实际写出来的代码量",
        "柱＝当周合并上线的 PR 个数（左轴）；折线＝当周主干净增代码行数（右轴）。",
        [{"type":"bar","data":g("pr_merged"),"color":BLUE,"label":"合并 PR 数","axis":"l"},
         {"type":"line","data":net,"color":ORANGE,"label":"净增代码行数","axis":"r"}])
    p2=ch.panel(0,340,1212,320,"待办存量：新提出 vs 关掉 vs 手里还压着多少",
        "柱＝当周新提 issue（不含 PR）；折线＝当周关闭数与周末仍未关闭的 issue 总数。",
        [{"type":"bar","data":g("iss_open"),"color":GOLD,"label":"新提 issue","axis":"l"},
         {"type":"line","data":g("iss_closed"),"color":AQUA,"label":"关闭 issue","axis":"l"},
         {"type":"line","data":g("backlog"),"color":VIO,"label":"周末未关闭存量","axis":"l"}])
    open(os.path.join(a.out_dir,"delivery.html"),"w").write(page(t1,[p1,p2],680,a.fonts_dir))
    hp=(tot("human")/tot("comments")*100) if tot("comments") else 0
    t2=(f'<h1>最近 {len(W)} 周趋势 · 投入面（{lab(W[0])} ~ {lab(D["target_week"]["end"])}）</h1>'
        f'<div class="lede">{len(W)} 周合计：来回讨论 <b>{tot("comments"):.0f}</b> 条（其中你发了 <b>{tot("human"):.0f}</b> 条，占 {hp:.0f}%），'
        f'AI 累计工作 <b>{tot("secs")/3600:.0f} 小时</b>，成本折合 <b>${tot("cost"):,.0f}</b>。</div>')
    p3=ch.panel(0,0,1212,320,"讨论轮数：AI 自己来回的次数 vs 你开口的次数",
        "堆叠柱＝当周 issue / PR 上的全部评论条数。",
        [{"type":"bar","data":g("bot"),"color":BLUE,"label":"AI 之间的来回","axis":"l","stack":True},
         {"type":"bar","data":g("human"),"color":GOLD,"label":"你发的","axis":"l","stack":True}])
    p4=ch.panel(0,340,1212,320,"花销：每周总成本 vs 每千行代码的单位成本",
        "柱＝当周总成本（按 API 标价折算，非订阅真实账单，左轴）；折线＝每写出 1000 行净增代码花多少钱（右轴）。",
        [{"type":"bar","data":g("cost"),"color":ORANGE,"label":"当周成本 $","axis":"l"},
         {"type":"line","data":kloc,"color":VIO,"label":"$ / 千行代码","axis":"r"}])
    open(os.path.join(a.out_dir,"effort.html"),"w").write(page(t2,[p3,p4],680,a.fonts_dir))
    print(f"[ok] HTML 已出：{a.out_dir}/delivery.html, effort.html")

if __name__=="__main__":
    main()
