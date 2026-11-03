"""Render the dsh-usage-stats panel in headless Chromium and screenshot it.

Usage:
    python3 verify.ui.py <port> [cookie[=name=value]] [out.png]

Environment overrides:
    UST_CHROME   path to a Chromium/Chrome binary (defaults to Playwright's own)
    UST_COOKIE_DB  desktop Chromium cookie db (defaults to the macOS location)

Without an explicit cookie the script reads the newest `dsh-auth-*` cookie from
the desktop app's Chromium cookie store and replays it for 127.0.0.1.
"""

import os
import sqlite3
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

COOKIE_DB = Path(
    os.environ.get(
        "UST_COOKIE_DB",
        Path.home() / "Library/Application Support/@deepseek-ai/dsh-desktop/Cookies",
    )
)

# Empty UST_CHROME = let Playwright launch its own bundled Chromium.
CHROME = os.environ.get("UST_CHROME", "")


def read_cookie() -> str:
    con = sqlite3.connect(f"file:{COOKIE_DB}?mode=ro", uri=True)
    try:
        row = con.execute(
            "select name||'='||value from cookies "
            "where name like 'dsh-auth-%' order by creation_utc desc limit 1"
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise SystemExit("no dsh-auth cookie found")
    return row[0]


def main() -> None:
    port = sys.argv[1] if len(sys.argv) > 1 else "52022"
    cookie = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else read_cookie()
    out = sys.argv[3] if len(sys.argv) > 3 else "/tmp/ust-panel.png"

    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        ctx = browser.new_context(viewport={"width": 1600, "height": 1800}, device_scale_factor=2)
        name, value = cookie.split("=", 1)
        ctx.add_cookies([{
            "name": name, "value": value, "domain": "127.0.0.1",
            "path": "/", "httpOnly": True,
        }])
        page = ctx.new_page()
        page.goto(f"http://127.0.0.1:{port}/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)

        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        # open the sidebar panel
        clicked = False
        for sel in [
            "button:has-text('Sessions & Usage')",
            "button:has-text('会话与用量')",
            "button:has-text('Session Stats')",
            "button:has-text('会话统计')",
        ]:
            try:
                el = page.locator(sel).first
                if el.count() > 0 and el.is_visible():
                    el.click()
                    clicked = True
                    break
            except Exception:
                continue
        page.wait_for_timeout(4000 if clicked else 800)

        panel = page.locator(".ust-root")
        if panel.count() == 0:
            page.screenshot(path=out, full_page=True)
            print("PANEL NOT FOUND; full page shot ->", out)
        else:
            panel.first.screenshot(path=out)
            print("panel shot ->", out)

        print("clicked_sidebar:", clicked)
        print("title:", page.locator(".ust-title").first.inner_text() if page.locator(".ust-title").count() else "-")
        for sel in [".ust-kpi-value", ".ust-metric-value", ".ust-perf-value", ".ust-donut-total"]:
            vals = page.locator(sel).all_inner_texts()
            print(sel, vals)
        if errors:
            print("console errors:", errors[:10])
        browser.close()


if __name__ == "__main__":
    main()
