"""Verify the AgentMesh dashboard against the richer demo project.

Renders the board, opens a task, checks a few real values, and reports console
errors plus horizontal overflow at two viewports.
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(r"<PROJECT>\web")
URL = "http://127.0.0.1:8792/"


def main() -> int:
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---- desktop -------------------------------------------------------
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(2000)

        body = page.inner_text("body")
        for needle in ["T-000001", "T-000002", "T-000003", "T-000004", "T-000005", "merged", "claimed"]:
            if needle not in body:
                failures.append(f"missing text on board: {needle}")

        overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if overflow > 1:
            failures.append(f"desktop horizontal overflow: {overflow}px")

        page.screenshot(path=str(OUT / "verify-desktop-board.png"), full_page=False)

        # open the first task card
        card = page.locator("text=T-000002").first
        try:
            card.click(timeout=5000)
            page.wait_for_timeout(1200)
            detail = page.inner_text("body")
            for needle in ["POST /api/links", "验收标准", "scope"]:
                if needle.lower() not in detail.lower():
                    failures.append(f"missing detail text: {needle}")
            page.screenshot(path=str(OUT / "verify-desktop-detail.png"), full_page=False)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"could not open task detail: {exc}")

        if errors:
            failures.append(f"console errors (desktop): {errors}")
        desktop_ok = True if not failures else False
        page.close()

        # ---- narrow --------------------------------------------------------
        narrow = browser.new_page(viewport={"width": 390, "height": 844})
        nerrors: list[str] = []
        narrow.on("console", lambda m: nerrors.append(m.text) if m.type == "error" else None)
        narrow.on("pageerror", lambda e: nerrors.append(str(e)))
        narrow.goto(URL, wait_until="networkidle")
        narrow.wait_for_timeout(1500)
        noverflow = narrow.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        if noverflow > 1:
            failures.append(f"narrow horizontal overflow: {noverflow}px")
        if nerrors:
            failures.append(f"console errors (narrow): {nerrors}")
        narrow.screenshot(path=str(OUT / "verify-narrow.png"), full_page=False)
        narrow.close()
        browser.close()

    report = {"ok": not failures, "failures": failures, "desktop_ok": desktop_ok}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
