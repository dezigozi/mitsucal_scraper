#!/usr/bin/env python3
"""
みつかる君 全自動スクレイピングツール
https://mitsucal.arai-denki.co.jp/mypages/login
全車種・全商品の価格情報を自動取得し、CSV に保存します。
"""

import csv
import logging
import os
import re
import sys
from datetime import datetime

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("scraper.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)

LOGIN_URL = "https://mitsucal.arai-denki.co.jp/mypages/login"
BASE_URL = "https://mitsucal.arai-denki.co.jp"
NAV_TIMEOUT = 60000
ELEM_TIMEOUT = 30000


def load_env():
    load_dotenv()
    username = os.getenv("MITSUCAL_USERNAME")
    password = os.getenv("MITSUCAL_PASSWORD")
    company_code = os.getenv("MITSUCAL_COMPANY_CODE", "")
    if not username or not password:
        raise ValueError(".env に MITSUCAL_USERNAME / MITSUCAL_PASSWORD を設定してください")
    return username, password, company_code


def extract_price(text):
    if not text:
        return None, ""
    text = text.strip()
    nums = re.findall(r"[\d,]+", text)
    if nums:
        try:
            return float(nums[0].replace(",", "")), text
        except ValueError:
            pass
    return None, text


def save_csv(data, filepath="mitsucal_prices.csv"):
    if not data:
        logger.warning("保存するデータがありません")
        return
    cols = ["取得日時", "メーカー", "車種名", "品番", "品名", "商品メーカー", "税抜価格", "価格テキスト", "カテゴリ"]
    with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(data)
    logger.info(f"{len(data)} 件を {filepath} に保存しました")


def login(page, username, password, company_code):
    logger.info("ログインページにアクセス中...")
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.screenshot(path="debug_login.png")
    page.fill("#MypageLoginId", username)
    page.fill("#MypagePassword", password)
    if company_code:
        page.fill("#MypageCompanyCd", company_code)
    page.click("input[type='image']")
    page.wait_for_selector(".topBox", timeout=ELEM_TIMEOUT)
    logger.info("ログイン成功")
    page.screenshot(path="debug_cars_page.png")


def get_makers(page):
    links = page.evaluate("""() => {
        const container = document.querySelector('.topBox ul');
        if (!container) return [];
        const as = container.querySelectorAll('a');
        const result = [];
        for (const a of as) {
            const img = a.querySelector('img');
            const alt = img ? img.alt : '';
            result.push({href: a.getAttribute('href'), name: alt});
        }
        return result;
    }""")
    return links


def get_cars(page):
    return page.evaluate("""() => {
        const cbs = document.querySelectorAll('input[name="data[Product][car_cd][]"]');
        const result = [];
        for (const cb of cbs) {
            const li = cb.closest('li');
            const img = li ? li.querySelector('img') : null;
            const name = img ? img.alt : '';
            result.push({value: cb.value, name: name});
        }
        return result;
    }""")


def get_products(page):
    return page.evaluate("""() => {
        const items = document.querySelectorAll('.products ul > li');
        const result = [];
        for (const li of items) {
            const fo14 = li.querySelector('span.fo14');
            const fo15 = li.querySelector('span.fo15');
            if (!fo14) continue;
            const html14 = fo14.innerHTML;
            const textParts = fo14.innerText.trim().split('\\n').map(s => s.trim()).filter(s => s);
            const hinban = textParts[0] || '';
            const hinmei = textParts[1] || '';
            const commentMatch = html14.match(/<!--\\s*\\n?\\s*(.+?)\\s*<br/);
            const maker = commentMatch ? commentMatch[1].trim() : '';
            const price = fo15 ? fo15.innerText.trim() : '';
            result.push({hinban, hinmei, maker, price});
        }
        return result;
    }""")


def run_scraper(username, password, company_code):
    all_data = []
    obtained_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, slow_mo=300)
        context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="ja-JP")
        page = context.new_page()
        page.set_default_timeout(NAV_TIMEOUT)
        page.set_default_navigation_timeout(NAV_TIMEOUT)

        try:
            login(page, username, password, company_code)

            makers = get_makers(page)
            logger.info(f"メーカー数: {len(makers)}")

            for mi, maker in enumerate(makers):
                maker_name = maker["name"]
                maker_href = maker["href"]
                logger.info(f"[{mi+1}/{len(makers)}] メーカー: {maker_name}")

                page.goto(BASE_URL + maker_href, wait_until="domcontentloaded")
                page.wait_for_selector(".carBox li", timeout=ELEM_TIMEOUT)

                cars = get_cars(page)
                logger.info(f"  車種数: {len(cars)}")

                for ci, car in enumerate(cars):
                    car_name = car["name"]
                    car_value = car["value"]
                    logger.info(f"  [{ci+1}/{len(cars)}] {car_name}")

                    # 車種ページに戻ってからチェック
                    page.goto(BASE_URL + maker_href, wait_until="domcontentloaded")
                    page.wait_for_selector(".carBox li", timeout=ELEM_TIMEOUT)

                    # JS でこの車種だけチェックしてフォーム送信
                    page.evaluate(
                        """(val) => {
                            const cbs = document.querySelectorAll('input[name="data[Product][car_cd][]"]');
                            for (const cb of cbs) cb.checked = false;
                            for (const cb of cbs) { if (cb.value === val) { cb.checked = true; break; } }
                            document.getElementById('ProductSelectCarsForm').submit();
                        }""",
                        car_value,
                    )
                    page.wait_for_timeout(5000)

                    if "/products/products" not in page.url:
                        logger.warning(f"    商品ページに遷移できませんでした: {page.url}")
                        continue

                    # 「全て」タブで一括取得（カテゴリ巡回はリクエスト過多で遷移失敗するため廃止）
                    products = get_products(page)
                    logger.info(f"    商品数: {len(products)}")

                    for prod in products:
                        tax, price_text = extract_price(prod["price"])
                        all_data.append({
                            "取得日時": obtained_at,
                            "メーカー": maker_name,
                            "車種名": car_name,
                            "品番": prod["hinban"],
                            "品名": prod["hinmei"],
                            "商品メーカー": prod["maker"],
                            "税抜価格": tax if tax is not None else "",
                            "価格テキスト": price_text,
                            "カテゴリ": "",
                        })

                # メーカー完了ごとに途中保存
                logger.info(f"  [{maker_name}] 完了 - 累計 {len(all_data)} 件（途中保存）")
                save_csv(all_data)

        except PlaywrightTimeout as e:
            logger.error(f"タイムアウト: {e}")
            save_csv(all_data)
        except Exception as e:
            logger.exception(f"エラー: {e}")
            save_csv(all_data)
        finally:
            browser.close()

    save_csv(all_data)
    logger.info(f"完了: 全 {len(all_data)} 件取得")


def run_test_mode():
    logger.info("=== テストモード ===")
    try:
        load_dotenv()
        u = os.getenv("MITSUCAL_USERNAME")
        p = os.getenv("MITSUCAL_PASSWORD")
        cc = os.getenv("MITSUCAL_COMPANY_CODE", "")
        if u and p and "your_" not in u and "your_" not in p:
            logger.info("OK: .env 認証情報あり")
        else:
            logger.warning("! .env 未設定")
        if cc:
            logger.info("  会社コード: 設定済み")
        logger.info(f"  URL: {LOGIN_URL}")
        with sync_playwright() as pw:
            b = pw.chromium.launch(headless=True)
            b.close()
        logger.info("OK: Playwright/Chromium 利用可能")
    except Exception as e:
        logger.error(f"エラー: {e}")
        sys.exit(1)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()

    if args.test:
        run_test_mode()
    else:
        username, password, company_code = load_env()
        run_scraper(username, password, company_code)
