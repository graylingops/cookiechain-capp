#!/usr/bin/env python3
"""verify_tx.py — read-only verification of a Cookie Chain transaction.

Given a transaction signature, fetches it from the Cookie Chain RPC and
verifies, with zero key material and zero spend:
  * the transaction exists and succeeded (no on-chain err)
  * it carries an SPL Memo v2 instruction (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)
  * the memo payload parses against the Cookie Jar schema: cookiejar:v1|<kind>|<note>

Usage:
  python3 verify_tx.py <signature> [--url RPC_URL] [--json]
  python3 verify_tx.py --selftest          # offline parser self-test (no RPC)
Exit 0 = valid jar memo tx; 1 = found but not a valid jar memo; 2 = not found / RPC error.

STRICTLY READ-ONLY: uses getTransaction / getSignatureStatuses only. No signing,
no airdrop, no fee funding, no keys — safe to run against any signature anyone
posts (e.g. in the X thread) as independent proof it landed on Cookie Chain.
"""
import argparse
import base64
import json
import sys
import urllib.request

MEMO_PID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
TAG = "cookiejar:v1"
KINDS = ("bake", "taste", "tip")
EXPLORER = "https://cookiescan.io/tx/"
DEFAULT_RPC = "https://rpc.cookiescan.io"

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        idx = _B58.find(c)
        if idx < 0:
            raise ValueError(
                f"invalid base58 character {c!r} (0, O, I and l are not in the "
                "base58 alphabet — check for typos)"
            )
        n = n * 58 + idx
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + raw


def rpc(url: str, method: str, params: list) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.load(r)
    if "error" in body:
        raise RuntimeError(f"RPC error: {body['error']}")
    return body["result"]


def memo_from_tx(tx: dict) -> bytes | None:
    msg = tx["transaction"]["message"]
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg.get("accountKeys", [])]
    for ix in msg.get("instructions", []):
        pid = ix.get("programId") or (keys[ix["programIdIndex"]] if keys else None)
        if pid == MEMO_PID:
            try:
                return b58decode(ix["data"])
            except ValueError as e:
                raise ValueError(f"memo instruction data is not valid base58: {e}") from e
    return None


def parse_memo(data: bytes):
    parts = data.decode("utf-8", "replace").split("|")
    # Guard the segment count too: a memo that is exactly "cookiejar:v1" (or any
    # single-segment payload) must yield "not a valid jar memo", not IndexError.
    if len(parts) < 2 or parts[0] != TAG or parts[1] not in KINDS:
        return None
    return {"kind": parts[1], "note": "|".join(parts[2:])[:200]}


def selftest() -> int:
    """Offline, $0, no RPC: exercise the parsers on the nasty inputs."""
    ok = True

    def b58encode(raw: bytes) -> str:
        n = int.from_bytes(raw, "big")
        out = ""
        while n:
            n, r = divmod(n, 58)
            out = _B58[r] + out
        return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + out

    def check(name, fn):
        nonlocal ok
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            ok = False
            print(f"  FAIL  {name}: {e}")

    def good_memo():
        assert parse_memo(b58decode(b58encode(b"cookiejar:v1|bake|hi"))) == \
            {"kind": "bake", "note": "hi"}
        assert parse_memo(b"cookiejar:v1|tip|a|b|c")["note"] == "a|b|c"
        assert parse_memo(b"cookiejar:v1|tip|" + b"x" * 300)["note"].endswith("xxx")

    def single_segment_memo():
        # A tx whose data is exactly the tag (no segments) must not IndexError.
        assert parse_memo(b"cookiejar:v1") is None

    def junk_memo():
        assert parse_memo(b"") is None
        assert parse_memo(b"hello world") is None
        assert parse_memo(b"cookiejar:v1|e|note") is None  # unknown kind

    def non_base58_decode():
        try:
            b58decode("0OIl")
        except ValueError as e:
            assert "not in the base58 alphabet" in str(e), e
        else:
            raise AssertionError("b58decode accepted non-base58 chars")

    def memo_from_tx_bad_data():
        tx = {"transaction": {"message": {"accountKeys": ["FeePayer1111111111111111111111111111111111"],
                                          "instructions": [{"programId": MEMO_PID, "data": "0OIl"}]}}}
        try:
            memo_from_tx(tx)
        except ValueError as e:
            assert "not valid base58" in str(e), e
        else:
            raise AssertionError("memo_from_tx accepted non-base58 memo data")

    check("valid memos parse", good_memo)
    check("single-segment memo (cookiejar:v1) -> None, no IndexError", single_segment_memo)
    check("junk/empty/unknown-kind memos -> None", junk_memo)
    check("non-base58 decode raises clean ValueError", non_base58_decode)
    check("memo_from_tx surfaces a clean message on bad data", memo_from_tx_bad_data)
    print("SELFTEST: PASS" if ok else "SELFTEST: FAIL")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("signature", nargs="?", help="transaction signature to verify")
    ap.add_argument("--url", default=DEFAULT_RPC)
    ap.add_argument("--json", action="store_true", help="emit the raw report as JSON")
    ap.add_argument("--selftest", action="store_true",
                    help="run the offline parser self-test (no RPC, no keys, no spend)")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.signature:
        ap.error("a signature is required (or pass --selftest)")

    # Clean pre-flight on the signature argument: a typo'd signature (base58 has
    # no 0, O, I or l) should get a plain-language message, never a traceback.
    if not a.signature or any(c not in _B58 for c in a.signature) or not (80 <= len(a.signature) <= 96):
        bad = sorted({c for c in a.signature if c not in _B58})
        print(
            "NOT A VALID BASE58 SIGNATURE: "
            + (f"unexpected character(s) {bad} — base58 has no 0, O, I or l; "
               "check for typos. " if bad else "")
            + f"Got {len(a.signature)} characters; a Solana signature is ~88.",
            file=sys.stderr,
        )
        if a.json:
            print(json.dumps({"signature": a.signature, "on_chain": False,
                              "error": "not a valid base58 signature"}, indent=2))
        return 2

    report = {
        "signature": a.signature,
        "explorer": EXPLORER + a.signature,
        "rpc": a.url,
        "on_chain": False,
        "success": None,
        "memo_program_instruction": False,
        "cookiejar_schema_valid": False,
        "memo": None,
        "slot": None,
        "block_time_utc": None,
        "fee_payer": None,
        "fee_lamports": None,
    }
    try:
        tx = rpc(a.url, "getTransaction",
                 [a.signature, {"encoding": "json", "maxSupportedTransactionVersion": 0}])
    except Exception as e:
        report["error"] = str(e)
        print(json.dumps(report, indent=2) if a.json else f"NOT FOUND / RPC ERROR: {e}", file=sys.stderr)
        return 2
    if tx is None:
        report["error"] = "transaction not found (not confirmed within history limit, or wrong network)"
        print(json.dumps(report, indent=2) if a.json else "NOT FOUND: no such transaction on this chain")
        return 2

    report["on_chain"] = True
    report["success"] = tx.get("meta", {}).get("err") is None
    report["slot"] = tx.get("slot")
    bt = tx.get("blockTime")
    if bt:
        import datetime
        report["block_time_utc"] = datetime.datetime.fromtimestamp(
            bt, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    msg = tx["transaction"]["message"]
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg.get("accountKeys", [])]
    if keys:
        report["fee_payer"] = keys[0]
    if tx.get("meta"):
        report["fee_lamports"] = tx["meta"].get("fee")

    try:
        data = memo_from_tx(tx)
    except ValueError as e:
        report["error"] = str(e)
        print(json.dumps(report, indent=2) if a.json else
              f"MEMO DECODE ERROR: {e}", file=sys.stderr)
        return 1
    report["memo_program_instruction"] = data is not None
    parsed = parse_memo(data) if data else None
    if parsed:
        report["cookiejar_schema_valid"] = True
        report["memo"] = parsed

    if a.json:
        print(json.dumps(report, indent=2))
        return 0 if (report["success"] and report["cookiejar_schema_valid"]) else 1

    print(f"signature : {report['signature']}")
    print(f"explorer  : {report['explorer']}")
    print(f"on-chain  : yes, slot {report['slot']}, block time {report['block_time_utc']}")
    print(f"success   : {report['success']}")
    print(f"fee payer : {report['fee_payer']} (fee {report['fee_lamports']} lamports)")
    print(f"memo ix   : {report['memo_program_instruction']} (SPL Memo v2 {MEMO_PID})")
    if report["cookiejar_schema_valid"]:
        print(f"schema    : VALID cookiejar:v1 -> kind={report['memo']['kind']!r} note={report['memo']['note']!r}")
        return 0
    print("schema    : NOT a valid cookiejar:v1 memo" +
          (f" (raw memo: {data!r})" if data else " (no memo instruction)"))
    return 1


if __name__ == "__main__":
    sys.exit(main())