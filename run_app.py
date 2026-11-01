"""TalkBridge AI Application Launcher.

Runs the FastAPI backend and opens the TalkBridge calling application
in a dedicated standalone desktop app window (via Chrome/Edge app mode)
or standard browser.

    python run_app.py          # this computer only (http://127.0.0.1:8000)
    python run_app.py --lan    # phones on the same Wi-Fi (HTTPS, port 8443)
"""

import argparse
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
import webbrowser

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PREFERRED_PORT = int(os.environ.get("TALKBRIDGE_PORT", "8000"))
PREFERRED_LAN_PORT = int(os.environ.get("TALKBRIDGE_LAN_PORT", "8443"))


def get_lan_ip() -> str:
    """This computer's address on the local network (no packets are sent)."""
    for probe in ("10.255.255.255", "192.168.255.255", "8.8.8.8"):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            try:
                s.connect((probe, 1))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
            except OSError:
                continue
    return ""


def find_free_port(preferred: int, attempts: int = 20) -> int:
    """Return `preferred` if it can be bound on all interfaces, else the next free port."""
    for port in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # Same option uvicorn uses, so a port just released by a previous
            # run (TIME_WAIT) counts as free instead of shifting to the next one.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in {preferred}-{preferred + attempts - 1}")


def get_python_interpreter() -> str:
    """Check if backend/.venv exists, otherwise use sys.executable."""
    venv_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend", ".venv")
    # Windows venvs use Scripts/python.exe; macOS/Linux use bin/python.
    for rel in (("Scripts", "python.exe"), ("bin", "python")):
        candidate = os.path.join(venv_dir, *rel)
        if os.path.isfile(candidate):
            return candidate
    return sys.executable


def wait_for_server(url: str, process: subprocess.Popen, timeout: int = 20, cafile: str = "") -> bool:
    start = time.time()
    context = ssl.create_default_context(cafile=cafile) if cafile else None
    while time.time() - start < timeout:
        if process.poll() is not None:
            return False  # server exited (e.g. import error); no point waiting
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=1, context=context) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def find_browser_app_executable() -> str:
    """Look for Chrome or Edge to launch in standalone --app mode."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path

    for path in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]:
        if os.path.isfile(path):
            return path

    for name in ["chrome", "google-chrome", "msedge", "edge"]:
        which = shutil.which(name)
        if which:
            return which
    return ""


def print_phone_instructions(phone_url: str) -> None:
    print("")
    print("=" * 60)
    print("  PHONES (connect them to the same Wi-Fi as this computer)")
    print(f"  Open:  {phone_url}/call/")
    print("=" * 60)
    print("  Android (Chrome): tap 'Advanced' -> 'Proceed' on the warning, once.")
    print("  iPhone (Safari), one-time setup so the call can connect:")
    print(f"    1. Open {phone_url}/talkbridge-ca.crt -> 'Allow' the profile download")
    print("    2. Settings -> General -> VPN & Device Management -> TalkBridge Local CA -> Install")
    print("    3. Settings -> General -> About -> Certificate Trust Settings ->")
    print("       turn ON 'TalkBridge Local CA'")
    print(f"    4. Open {phone_url}/call/")
    print("  If phones can't load the page: allow incoming connections for Python")
    print("  in the firewall prompt, and avoid guest Wi-Fi (it isolates devices).")
    print("")


def main() -> None:
    parser = argparse.ArgumentParser(description="Start TalkBridge AI")
    parser.add_argument("--lan", action="store_true", help="serve over HTTPS so phones on the same Wi-Fi can join")
    args = parser.parse_args()

    backend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend")
    py_exe = get_python_interpreter()

    ssl_args: list = []
    cafile = ""
    lan_ip = ""
    if args.lan:
        lan_ip = get_lan_ip()
        if not lan_ip:
            print("[-] Not connected to a network: join Wi-Fi first, then run with --lan again.")
            sys.exit(1)
        hosts = [socket.gethostname()]
        out = subprocess.run(
            [py_exe, "-m", "app.lan_cert", "--out", os.path.join(backend_dir, "certs"), "--ip", lan_ip]
            + [arg for h in hosts for arg in ("--host", h)],
            cwd=backend_dir, capture_output=True, text=True,
        )
        if out.returncode != 0:
            print(out.stderr)
            print("[-] Could not create the HTTPS certificate (is `cryptography` installed in backend/.venv?)")
            sys.exit(1)
        certs = json.loads(out.stdout)
        cafile = certs["ca"]
        ssl_args = ["--ssl-certfile", certs["cert"], "--ssl-keyfile", certs["key"]]

    port = find_free_port(PREFERRED_LAN_PORT if args.lan else PREFERRED_PORT)
    preferred = PREFERRED_LAN_PORT if args.lan else PREFERRED_PORT
    scheme = "https" if args.lan else "http"
    # 127.0.0.1 rather than localhost: localhost may resolve to IPv6 (::1), where
    # another local dev server can be listening on the same port.
    url = f"{scheme}://127.0.0.1:{port}"

    print("=" * 60)
    print("  [*] Starting TalkBridge AI - Live Translation Calling App")
    print(f"  [*] URL: {url}")
    print("=" * 60)
    if port != preferred:
        print(f"[!] Port {preferred} is in use by another program; using {port} instead.")
    print(f"[*] Using Python: {py_exe}")

    server_cmd = [
        py_exe,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        str(port),
    ] + ssl_args

    server_process = subprocess.Popen(server_cmd, cwd=backend_dir)

    try:
        print("[*] Waiting for backend server to initialize...")
        if wait_for_server(url, server_process, timeout=25, cafile=cafile):
            print("[+] Server is online!")

            if args.lan:
                # Phones are the clients; this computer's browser doesn't trust
                # the local CA, so don't open a window that shows a warning.
                print_phone_instructions(f"https://{lan_ip}:{port}")
                print("[*] TalkBridge AI is active! Press Ctrl+C to stop.")
                server_process.wait()
                return

            browser_path = find_browser_app_executable()
            if browser_path:
                print(f"[+] Opening App Window via {os.path.basename(browser_path)}...")
                subprocess.Popen([browser_path, f"--app={url}/call/", "--window-size=480,900"])
            else:
                print("[+] Opening default browser...")
                webbrowser.open(f"{url}/call/")
            print(f"[*] Call screen: {url}/call/   (classic dashboard: {url}/)")

            print("[*] TalkBridge AI is active! Press Ctrl+C to stop.")
            server_process.wait()
        else:
            print("[-] Server failed to start - see the error output above.")
    except KeyboardInterrupt:
        print("\n[*] Shutting down TalkBridge AI...")
    finally:
        server_process.terminate()
        try:
            server_process.wait(timeout=3)
        except Exception:
            server_process.kill()
        print("[*] Stopped.")


if __name__ == "__main__":
    main()
