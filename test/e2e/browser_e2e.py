"""
End-to-end browser test of the self-hosted app with a simulated phone camera.

Chrome's fake camera plays a video file, so the real face models run on real pixels.
Phone A (the attendee) registers through the UI with the camera.
Phone B (the scanner) is a second registered attendee. Her registration is created through the API
with a synthetic template because the fake camera can only show one face.

Usage:
  python3 test/e2e/browser_e2e.py --face face.y4m --noface noface.y4m [--chrome /usr/bin/google-chrome]
The face video should be a short clip of one consenting person (for example yourself).
"""
import argparse, json, os, random, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SCREENS = None
PROFILE = json.loads((ROOT / "test/fixtures/mani.json").read_text())


def start_server(port):
    env = dict(os.environ, PORT=str(port), ADMIN_KEY="e2e-admin", EVENT_NAME="E2E Test Conference")
    env.pop("ANTHROPIC_API_KEY", None)
    p = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/event", timeout=1)
            return p
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def api(base, path, body=None, token=None):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    return json.loads(urllib.request.urlopen(req).read())


def register_priya(base):
    rnd = random.Random(11)
    v = [rnd.uniform(-1, 1) for _ in range(128)]
    n = sum(x * x for x in v) ** 0.5
    out = api(base, "/api/enroll", {
        "descriptor": [x / n for x in v],
        "profile": {"fullName": "Priya Sharma", "role": "PhD student, AI governance", "organization": "University of Florida"},
        "policy": {"mode": "everyone"},
        "consent": {"biometric": True, "scanLogging": True},
    })
    return out["token"]


def launch(pw, chrome, video):
    return pw.chromium.launch(executable_path=chrome, headless=True, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-video-capture={video}", "--no-sandbox"])


def phone(browser, token=None):
    ctx = browser.new_context(viewport={"width": 420, "height": 900}, device_scale_factor=2)
    if token:
        ctx.add_init_script(f"localStorage.setItem('cfc_token', {json.dumps(token)})")
    return ctx.new_page()


def wait_models(page):
    page.wait_for_function("document.querySelector('#modelStatus').textContent.includes('ready')", timeout=60000)


def register_mani(page, base):
    page.goto(base)
    wait_models(page)
    page.fill("input[name=fullName]", PROFILE["profile"]["fullName"])
    page.fill("input[name=role]", PROFILE["profile"]["role"])
    page.fill("input[name=organization]", PROFILE["profile"]["organization"])
    page.fill("input[name=linkedin]", PROFILE["profile"]["linkedin"])
    page.check("input[name=consentBio]")
    page.check("input[name=consentRules]")
    if SCREENS:
        page.evaluate("window.scrollTo(0,0)"); page.screenshot(path=f"{SCREENS}/register.png", full_page=False)
    page.click("#startEnrollCam")
    page.wait_for_selector("#enrollBtn:not([disabled])", timeout=20000)
    t0 = time.time()
    page.click("#enrollBtn")
    try:
        page.wait_for_selector("#enrollDone:not([hidden])", timeout=60000)
    except Exception:
        raise AssertionError("registration failed: " + page.inner_text("#enrollMsg"))
    return time.time() - t0


def scan_until(page, base, js_condition, purpose="Enjoyed your talk on EU AI Act conformity", first=True):
    if first:
        page.goto(base)
        wait_models(page)
    page.click("button[data-tab=scan]")
    page.fill("#reqPurpose", purpose)
    t0 = time.time()
    page.click("#scanBtn")
    page.wait_for_function(js_condition, timeout=40000)
    return time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--face", required=True)
    ap.add_argument("--noface", required=True)
    ap.add_argument("--chrome", default="/usr/bin/google-chrome")
    ap.add_argument("--screens", default=str(ROOT / "e2e-output"))
    a = ap.parse_args()
    Path(a.screens).mkdir(parents=True, exist_ok=True)
    global SCREENS
    SCREENS = a.screens
    R = {}

    with sync_playwright() as pw:
        # ---- Scenario 1: registered attendee is scanned, logged, then blocks the scanner ----
        port = 3111
        srv = start_server(port)
        base = f"http://127.0.0.1:{port}"
        try:
            browser = launch(pw, a.chrome, a.face)
            mani = phone(browser)
            R["register_seconds"] = round(register_mani(mani, base), 2)

            priya = phone(browser, register_priya(base))
            R["scan_to_result_seconds"] = round(scan_until(priya, base, "!!document.querySelector('#openLinkedIn')"), 2)
            R["scan_status"] = priya.inner_text("#scanState")
            href = priya.get_attribute("#openLinkedIn", "href")
            assert href == PROFILE["profile"]["linkedin"], href
            R["linkedin_href"] = href
            R["scanner_sees"] = priya.inner_text("#resultCard")
            priya.screenshot(path=f"{a.screens}/result.png", full_page=True)

            mani.click("button[data-tab=inbox]")
            mani.wait_for_selector(".req button[data-action=block]", timeout=10000)
            R["log_entry"] = mani.inner_text(".req")
            assert "Priya Sharma scanned you" in R["log_entry"]
            mani.screenshot(path=f"{a.screens}/log.png", full_page=True)
            mani.click(".req button[data-action=block]")
            mani.wait_for_selector(".req button[data-action=unblock]", timeout=10000)

            scan_until(priya, base, "document.querySelector('#resultCard') && document.querySelector('#resultCard').dataset.tier === '0'", first=False)
            R["after_block"] = priya.inner_text("#resultCard")
            assert "not sharing" in R["after_block"]

            R["eval_csv"] = urllib.request.urlopen(f"{base}/api/admin/eval.csv?key=e2e-admin").read().decode()
            assert "Manish" not in R["eval_csv"] and "Priya" not in R["eval_csv"]
            browser.close()
        finally:
            srv.terminate()

        # ---- Scenario 2: face of a person who never registered ----
        port = 3112
        srv = start_server(port)
        base = f"http://127.0.0.1:{port}"
        try:
            browser = launch(pw, a.chrome, a.face)
            page = phone(browser, register_priya(base))
            scan_until(page, base, "document.querySelector('#scanState').textContent.includes('not registered')")
            R["not_registered"] = page.inner_text("#scanState")
            assert page.query_selector("#resultCard") is None
            browser.close()
        finally:
            srv.terminate()

        # ---- Scenario 3: no face in view; Scenario 4: unregistered phone cannot scan ----
        port = 3113
        srv = start_server(port)
        base = f"http://127.0.0.1:{port}"
        try:
            browser = launch(pw, a.chrome, a.noface)
            page = phone(browser, register_priya(base))
            scan_until(page, base, "document.querySelector('#scanState').textContent.includes('Looking for a face')")
            R["no_face"] = page.inner_text("#scanState")
            anon = phone(browser)
            scan_until(anon, base, "document.querySelector('#scanState').textContent.includes('Register first')")
            R["unregistered_scanner"] = anon.inner_text("#scanState")
            browser.close()
        finally:
            srv.terminate()

    print(json.dumps(R, indent=2))
    print("E2E PASSED")


if __name__ == "__main__":
    sys.exit(main())
