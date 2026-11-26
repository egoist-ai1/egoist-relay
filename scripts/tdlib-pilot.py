"""Проверяет готовность TDLib на Windows и SOCKS5-маршрут без входа в Telegram."""

import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import sys
import time


TDJSON_SHA256 = "3eb3619ce74e889d3a0e5c0c68aaa0457c5a52c538f8777b73b933744ff4f4ec"
TDLIB_TIMEOUT_SECONDS = 6.0
RESPONSE_GRACE_SECONDS = 2.0
DATACENTERS = (1, 2, 3, 4, 5)


def parse_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Укажите номер порта SOCKS5") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("Порт SOCKS5 должен быть в диапазоне 1–65535")
    return port


def load_tdlib(library_path: Path) -> ctypes.CDLL:
    with library_path.open("rb") as library_file:
        digest = hashlib.file_digest(library_file, "sha256").hexdigest()
    if digest != TDJSON_SHA256:
        raise ValueError("SHA-256 tdjson.dll отличается от проверяемой сборки")

    library = ctypes.CDLL(str(library_path.resolve()))
    library.td_create_client_id.argtypes = []
    library.td_create_client_id.restype = ctypes.c_int
    library.td_execute.argtypes = [ctypes.c_char_p]
    library.td_execute.restype = ctypes.c_char_p
    library.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
    library.td_send.restype = None
    library.td_receive.argtypes = [ctypes.c_double]
    library.td_receive.restype = ctypes.c_char_p
    return library


def encode_request(**fields) -> bytes:
    return json.dumps(fields, separators=(",", ":")).encode("utf-8")


def execute(library: ctypes.CDLL, method: str, **fields) -> dict:
    response = library.td_execute(encode_request(**{"@type": method}, **fields))
    return json.loads(response)


def probe(library: ctypes.CDLL, port: int) -> list[dict]:
    client_id = library.td_create_client_id()
    proxy = {
        "@type": "proxy",
        "server": "127.0.0.1",
        "port": port,
        "type": {"@type": "proxyTypeSocks5"},
    }
    pending = {}
    results = {}

    try:
        for datacenter in DATACENTERS:
            pending[datacenter] = time.monotonic()
            library.td_send(
                client_id,
                encode_request(
                    **{"@type": "testProxy", "@extra": datacenter},
                    proxy=proxy,
                    dc_id=datacenter,
                    timeout=TDLIB_TIMEOUT_SECONDS,
                ),
            )

        deadline = time.monotonic() + TDLIB_TIMEOUT_SECONDS + RESPONSE_GRACE_SECONDS
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            response = library.td_receive(remaining)
            if not response:
                continue
            result = json.loads(response)
            datacenter = result.get("@extra")
            if result.get("@client_id") != client_id or datacenter not in pending:
                continue

            elapsed_ms = round((time.monotonic() - pending.pop(datacenter)) * 1000)
            check = {"dc": datacenter, "elapsedMs": elapsed_ms}
            if result["@type"] == "ok":
                check["status"] = "ok"
            else:
                check["status"] = "timeout" if result.get("message") == "Timeout expired" else "error"
                check["tdlibCode"] = result.get("code")
            results[datacenter] = check
    finally:
        library.td_send(client_id, encode_request(**{"@type": "close"}))
        deadline = time.monotonic() + RESPONSE_GRACE_SECONDS
        while (remaining := deadline - time.monotonic()) > 0:
            response = library.td_receive(remaining)
            if not response:
                break
            result = json.loads(response)
            if (result.get("@client_id") == client_id
                    and result.get("authorization_state", {}).get("@type") == "authorizationStateClosed"):
                break

    return [results.get(dc, {"dc": dc, "status": "no-response"}) for dc in DATACENTERS]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True, help="Путь к проверенной tdjson.dll")
    parser.add_argument("--socks-port", type=parse_port, required=True, help="Порт SOCKS5 на 127.0.0.1")
    args = parser.parse_args()

    try:
        library = load_tdlib(args.library)
    except (OSError, ValueError) as error:
        parser.error(str(error))

    execute(library, "setLogVerbosityLevel", new_verbosity_level=0)
    version = execute(library, "getOption", name="version")["value"]
    commit = execute(library, "getOption", name="commit_hash")["value"]
    results = probe(library, args.socks_port)
    print(json.dumps({"tdlib": version, "commit": commit, "datacenters": results}, indent=2))
    return 0 if all(result["status"] == "ok" for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
