"""M4 验收脚本：任务（mission）两页 + 看板回归。

只读：打开页面、量 DOM、截图，不点任何写操作（这个观察台本来也没有写操作）。
跑法（PowerShell，先补 PATH）：
    $env:PATH = "C:\\Users\\HP\\.agents\\bin;$env:PATH"; python tests/m4-missions-ui.py
"""
import io
import json
import os
import re
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("MESH_BASE", "http://127.0.0.1:8792").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "screenshots")
TITLE = "做一个带登录的博客"
EVIDENCE = "verified against the acceptance criteria"
CRITERION = "POST /api/login 返回 200"

results = []


def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": str(detail)[:400]})
    return ok


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(ROOT, ".tmp"), exist_ok=True)
    console_errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

        # ---- 1. 列表页 ----
        page.goto(f"{BASE}/#/missions", wait_until="networkidle")
        page.wait_for_selector(".mrow", timeout=15000)
        rows = page.locator(".mrow")
        check("list: 一条 mission 一行（去重后只有 1 行）", rows.count() == 1, f"rows={rows.count()}")
        list_text = page.inner_text("body")
        check("list: 标题出现", TITLE in list_text)
        check("list: 状态 completed 出现", "completed" in list_text)
        check("list: lead 出现", "mesh-human" in list_text)
        check("list: 进度 3/3", "3/3" in list_text)
        check("list: 轮次出现", "轮次" in list_text)
        # 时长必须是 humanised（1m 06s / 42s / 2h 05m），不能是裸的 duration_ms
        dur_text = page.locator(".mrow-dur").first.inner_text().strip()
        check("list: 时长 humanised（不是裸毫秒）", re.match(r"^(\d+h \d{2}m|\d+m \d{2}s|\d+s|\d+ms)$", dur_text) is not None,
              dur_text)
        check("list: HISTORY.md 路径出现", ".mesh/HISTORY.md" in list_text)
        first = rows.first
        check("list: 行是 <a> 且 href 指向详情",
              first.evaluate("el => el.tagName === 'A' && el.getAttribute('href') === '#/missions/M-000001'"),
              first.evaluate("el => el.tagName + ' ' + el.getAttribute('href')"))
        page.screenshot(path=os.path.join(OUT, "m4-missions-list.png"), full_page=False)

        # ---- 2. 详情页 ----
        page.goto(f"{BASE}/#/missions/M-000001", wait_until="networkidle")
        page.wait_for_selector("#m-cards", timeout=15000)
        page.wait_for_selector("#m-report", timeout=15000)
        detail_text = page.inner_text("body")
        check("detail: 标题出现", TITLE in detail_text)
        check("detail: 至少一条 evidence 出现", EVIDENCE in detail_text)
        check("detail: 逐条条款文字出现", CRITERION in detail_text)
        check("detail: 时间线有事件（>=20 条）", page.locator(".timeline .tl-item").count() >= 20,
              f"tl={page.locator('.timeline .tl-item').count()}")
        check("detail: 时间线把 session 翻成了 agent",
              any("scripted-02" in t for t in page.locator(".timeline .tl-who").all_inner_texts()))
        # chip 的中文标签来自后端 `timeline[].label`（和 timeline.md 用同一张表，前端不自己维护翻译）。
        # 没有 label 的旧数据会回退成 kind —— 那条断言就会失败，正好提醒去补 label。
        chips = [c.strip() for c in page.locator(".timeline .chip").all_inner_texts()]
        raw_kinds = [c for c in chips if re.match(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$", c)]
        check("detail: 时间线 chip 是中文 label（不是 raw kind）", not raw_kinds,
              f"chips={len(chips)} raw={raw_kinds[:6]}")
        check("detail: chip 里出现预期的中文标签", all(w in chips for w in ["合并", "领取", "建卡"]),
              f"chips={sorted(set(chips))}")
        check("detail: task_id 链到看板",
              page.locator('.mcard-head a[href="#/board?task=T-000001"]').count() == 1)
        check("detail: 3 张卡", page.locator(".mcard").count() == 3, f"cards={page.locator('.mcard').count()}")
        check("detail: 4 条审查（含 T-000003 的两次）", page.locator(".mrev").count() == 4,
              f"reviews={page.locator('.mrev').count()}")
        check("detail: PASS 标记出现", page.locator('.chain-item[data-pass="true"]').count() >= 6,
              f"pass={page.locator('.chain-item[data-pass=\"true\"]').count()}")
        check("detail: 报告已渲染成 markdown（表格）", page.locator(".mreport table").count() == 1,
              f"tables={page.locator('.mreport table').count()}")
        report_html = page.locator(".mreport").first.inner_html() if page.locator(".mreport").count() else ""
        check("detail: 报告没有原始 HTML 注入", "<script" not in report_html.lower())
        check("detail: 标题进 document.title", "AgentMesh" in page.title() and "M-000001" in page.title(),
              page.title())
        page.screenshot(path=os.path.join(OUT, "m4-mission-detail.png"), full_page=False)
        # 整页截图在这个 shell 里没有意义（滚动发生在 #view-scroll 内部，文档本身是 100dvh）。
        # 用页内跳转把证据段/报告段滚到顶部，再拍视口 —— 顺便验证跳转按钮真的能用。
        page.click('button[data-to="m-cards"]')
        page.wait_for_timeout(1500)
        # .msec 有 scroll-margin-top: 8px，所以落点是「贴着顶部往下一指甲」，不是 0。
        check("jump: 跳到「卡片与证据」后该分区贴住滚动容器顶部",
              page.evaluate("() => { const s = document.getElementById('view-scroll'); "
                            "const r = document.getElementById('m-cards').getBoundingClientRect(); "
                            "return Math.abs(r.top - s.getBoundingClientRect().top) < 40; }"),
              page.evaluate("() => Math.round(document.getElementById('m-cards').getBoundingClientRect().top - "
                            "document.getElementById('view-scroll').getBoundingClientRect().top)"))
        page.screenshot(path=os.path.join(OUT, "m4-mission-evidence.png"))
        page.click('button[data-to="m-report"]')
        page.wait_for_timeout(1500)
        page.screenshot(path=os.path.join(OUT, "m4-mission-report.png"))
        page.click('button[data-to="m-time"]')
        page.wait_for_timeout(600)

        # ---- 3. “只看未通过”过滤 ----
        page.click('button[data-act="mfail"][data-on="true"]')
        page.wait_for_timeout(250)
        fail_cards = page.locator(".mcard").count()
        fail_text = page.inner_text("#m-cards")
        check("filter: 只看未通过 → 0 张卡且有诚实空状态", fail_cards == 0 and "没有未通过的条款" in fail_text,
              f"cards={fail_cards}")
        page.click('button[data-act="mfail"][data-on="false"]')
        page.wait_for_timeout(250)
        check("filter: 切回全部 → 3 张卡", page.locator(".mcard").count() == 3)

        # ---- 3b. 同一个搜索框在详情页过滤卡 ----
        page.fill("#q", "T-000002")
        page.wait_for_timeout(500)
        check("search: 详情页关键词过滤卡（T-000002 → 1 张）", page.locator(".mcard").count() == 1,
              f"cards={page.locator('.mcard').count()}")
        check("search: 关键词写进 URL", "q=T-000002" in page.url, page.url)
        page.fill("#q", "")
        page.wait_for_timeout(500)
        check("search: 清空后回到 3 张卡", page.locator(".mcard").count() == 3)

        # ---- 4. 看板回归（路由改造后仍然可用）----
        page.goto(f"{BASE}/#/board", wait_until="networkidle")
        page.wait_for_selector(".lane", timeout=15000)
        board_text = page.inner_text("body")
        check("board: 泳道渲染", page.locator(".lane").count() >= 1, f"lanes={page.locator('.lane').count()}")
        check("board: 任务卡出现", "T-000001" in board_text)
        page.screenshot(path=os.path.join(OUT, "m4-board-regression.png"))

        # 查询式路由 + 详情面板
        page.goto(f"{BASE}/#/board?task=T-000001&tab=verdict", wait_until="networkidle")
        page.wait_for_selector("#panel:not([hidden])", timeout=15000)
        check("board: ?task= 打开面板", page.locator("#panel .panel-title").inner_text().strip() != "",
              page.locator("#panel .panel-title").inner_text())
        check("board: hash 未被路由改造破坏",
              "task=T-000001" in page.url and "tab=verdict" in page.url, page.url)

        # ---- 5. 键盘：Tab 到第一行，Enter 进详情 ----
        page.goto(f"{BASE}/#/missions", wait_until="networkidle")
        page.wait_for_selector(".mrow")
        page.locator(".mrow").first.focus()
        focused = page.evaluate("() => document.activeElement.className")
        check("a11y: 列表行可聚焦", "mrow" in focused, focused)
        page.keyboard.press("Enter")
        page.wait_for_selector("#m-cards", timeout=15000)
        check("a11y: 行内 Enter 进入详情", page.url.endswith("#/missions/M-000001"), page.url)

        # ---- 5b. 键盘快捷键 g r ----
        page.goto(f"{BASE}/#/board", wait_until="networkidle")
        page.wait_for_selector(".lane", timeout=15000)
        page.keyboard.press("g")
        page.keyboard.press("r")
        page.wait_for_timeout(400)
        check("a11y: g r 跳到任务单", page.url.endswith("#/missions"), page.url)
        check("a11y: 导航高亮当前视图",
              page.locator('.nav-link[data-nav="missions"]').get_attribute("aria-current") == "page")

        # ---- 6. 390px ----
        narrow = browser.new_page(viewport={"width": 390, "height": 844})
        narrow.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        narrow.goto(f"{BASE}/#/missions/M-000001", wait_until="networkidle")
        narrow.wait_for_selector("#m-cards", timeout=15000)
        overflow = narrow.evaluate("""() => {
            const s = document.getElementById('view-scroll');
            const r = document.querySelector('.mrow') || document.querySelector('.mhero');
            return { scroll: s.scrollWidth - s.clientWidth, heroRight: r ? r.getBoundingClientRect().right : 0,
                     docScroll: document.documentElement.scrollWidth };
        }""")
        check("390px: 主栏没有横向溢出", overflow["scroll"] <= 1 and overflow["docScroll"] <= 390, overflow)
        narrow.screenshot(path=os.path.join(OUT, "m4-mission-detail-390.png"), full_page=False)
        narrow.goto(f"{BASE}/#/missions", wait_until="networkidle")
        narrow.wait_for_selector(".mrow")
        narrow.screenshot(path=os.path.join(OUT, "m4-missions-list-390.png"), full_page=False)

        # ---- 7. prefers-reduced-motion ----
        reduce = browser.new_page(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        reduce.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        reduce.goto(f"{BASE}/#/missions/M-000001", wait_until="networkidle")
        reduce.wait_for_selector("#m-cards", timeout=15000)
        reduce.click('button[data-to="m-cards"]')
        reduce.wait_for_timeout(200)
        check("reduced-motion: 页内跳转不报错且目标获得焦点",
              reduce.evaluate("() => document.activeElement && document.activeElement.id === 'm-cards'"),
              reduce.evaluate("() => document.activeElement && document.activeElement.id"))

        # ---- 8. 404 mission ----
        before_404 = len(console_errors)  # 这一条是故意打的 404，浏览器必然在 console 里记一笔
        page.goto(f"{BASE}/#/missions/M-999999", wait_until="networkidle")
        page.wait_for_selector(".view-error", timeout=15000)
        check("404: 诚实报错而不是白屏", "加载失败" in page.inner_text(".view-error"),
              page.inner_text(".view-error")[:80])
        check("404: 只有那一条预期的 404 console 记录",
              all("404" in m for m in console_errors[before_404:]),
              console_errors[before_404:])

        # ---- 9. 其它视图回归：路由改造必须对它们零影响 ----
        for route, sel in [("#/overview", ".ov-grid"), ("#/board", ".lane"), ("#/sessions", ".split"),
                           ("#/audit", ".audit-layout"), ("#/messages", ".msg-list"), ("#/agents", ".tbl")]:
            page.goto(f"{BASE}/{route}", wait_until="networkidle")
            try:
                page.wait_for_selector(sel, timeout=10000)
                ok = True
            except Exception:
                ok = False
            check(f"regression: {route} 仍渲染（{sel}）", ok, route)

        real_errors = [m for m in console_errors if "404 (Not Found)" not in m]
        check("no console errors（除了故意触发的 404）", not real_errors, real_errors[:5])
        browser.close()

    passed = sum(1 for r in results if r["ok"])
    payload = {"passed": passed, "total": len(results), "results": results}
    # 顺手落一份 UTF-8 的结果文件：PowerShell 的 `>` 会把 stdout 写成 UTF-16。
    with io.open(os.path.join(ROOT, ".tmp", "m4-verify.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    print(json.dumps(payload, ensure_ascii=True, indent=1))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
