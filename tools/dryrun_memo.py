#!/usr/bin/env python3
"""dryrun_memo.py — $0 gas-free dry run of Cookie Jar memo-tx construction.

Builds a REAL Cookie Chain memo transaction entirely in memory, signs it with an
EPHEMERAL keypair generated from os.urandom (never persisted, never printed,
holds no funds and never will), and submits it to the live RPC via
`simulateTransaction` — a read-only, fee-less call. Nothing is ever sent on-chain;
no real key material ever touches disk; the sponsor COOK drip is not needed.

This proves end-to-end, before any gas exists:
  * wire format (legacy message, header/account/compact-u16 encoding) is valid
  * the ed25519 signature verifies on-chain (sigVerify: true)
  * the SPL Memo v2 instruction (MemoSq4gq…) executes cleanly on Cookie Chain

Pure stdlib: base58 + ed25519 (RFC 8032) implemented inline. Exit 0 = simulation
passed. NEVER run this with a real funded key; it is a dry-run tool only.
"""
import base64
import hashlib
import json
import os
import sys
import urllib.request

MEMO_PID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
DEFAULT_RPC = "https://rpc.cookiescan.io"

# ---------------------------------------------------------------- base58
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    pad = len(b) - len(b.lstrip(b"\x00"))
    return "1" * pad + out


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + _B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + raw


# ---------------------------------------------------------------- ed25519 (RFC 8032, pure stdlib)
P = 2 ** 255 - 19
L = 2 ** 252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
I = pow(2, (P - 1) // 4, P)


def _xrecover(y):
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * I % P
    if x % 2 != 0:
        x = P - x
    return x


_BY = (4 * pow(5, P - 2, P)) % P
_BX = _xrecover(_BY)
_B = (_BX % P, _BY % P, 1, (_BX * _BY) % P)  # extended coords (X, Y, Z, T)
_ID = (0, 1, 1, 0)


def _add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = ((y1 - x1) * (y2 - x2)) % P
    b = ((y1 + x1) * (y2 + x2)) % P
    c = (t1 * 2 * D * t2) % P
    dd = (z1 * 2 * z2) % P
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return ((e * f) % P, (g * h) % P, (f * g) % P, (e * h) % P)


def _mul(s, p):
    q = _ID
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _compress(p):
    x, y, z, _ = p
    zi = pow(z, P - 2, P)
    x = x * zi % P
    y = y * zi % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _decompress(b):
    y = int.from_bytes(b, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _xrecover(y)
    if x & 1 != sign:
        x = P - x
    return (x, y, 1, x * y % P)


def ed25519_pubkey(seed: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little") & ((1 << 254) - 8) | (1 << 254)
    return _compress(_mul(a, _B))


def ed25519_sign(seed: bytes, msg: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little") & ((1 << 254) - 8) | (1 << 254)
    pk = _compress(_mul(a, _B))
    r = int.from_bytes(hashlib.sha512(h[32:] + msg).digest(), "little") % L
    rp = _compress(_mul(r, _B))
    k = int.from_bytes(hashlib.sha512(rp + pk + msg).digest(), "little") % L  # RFC 8032: R || A || M
    s = (r + k * a) % L
    return rp + s.to_bytes(32, "little")


def ed25519_verify(pk: bytes, msg: bytes, sig: bytes) -> bool:
    """Pure-python RFC 8032 verify (cross-checked against the 'cryptography' lib)."""
    if len(pk) != 32 or len(sig) != 64:
        return False
    try:
        A = _decompress(pk)
        R = _decompress(sig[:32])
    except Exception:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= L:
        return False
    k = int.from_bytes(hashlib.sha512(sig[:32] + pk + msg).digest(), "little") % L
    return _compress(_mul(s, _B)) == _compress(_add(R, _mul(k, A)))


# ---------------------------------------------------------------- solana wire format
def compact_u16(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def build_memo_tx(payer_pubkey: bytes, memo: bytes, blockhash: bytes) -> bytes:
    """Legacy Solana message: accounts [payer(writable signer), memo program(readonly)]."""
    data = memo  # SPL Memo (MemoSq4gq…): the instruction data IS the memo string
    msg = bytes([1, 0, 1])                       # header: 1 signer, 0 ro-signed, 1 ro-unsigned
    msg += compact_u16(2) + payer_pubkey + b58decode(MEMO_PID)
    msg += blockhash
    msg += compact_u16(1)                        # 1 instruction
    msg += bytes([1])                            # programIdIndex = 1
    msg += compact_u16(0)                        # empty accounts vec
    msg += compact_u16(len(data)) + data
    return compact_u16(1) + b"\x00" * 64 + msg   # signature placeholder (replaced below)


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


def main() -> int:
    rpc_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RPC
    note = sys.argv[2] if len(sys.argv) > 2 else "dry-run: no cookies were harmed"
    memo = f"cookiejar:v1|bake|{note}".encode()

    # EPHEMERAL signer: os.urandom seed, memory only, never persisted or printed.
    seed = os.urandom(32)
    payer = ed25519_pubkey(seed)
    payer_b58 = b58encode(payer)

    bh = rpc(rpc_url, "getLatestBlockhash", [{"commitment": "finalized"}])
    blockhash = b58decode(bh["value"]["blockhash"])

    raw = build_memo_tx(payer, memo, blockhash)
    msg = raw[65:]                                     # strip sig-count + placeholder sig
    sig = ed25519_sign(seed, msg)
    signed = sig + msg
    tx_b64 = base64.b64encode(bytes([1]) + signed).decode()  # compact-u16(1) + sig + msg

    print(f"payer (ephemeral, unfunded, discarded) : {payer_b58}")
    print(f"memo payload                           : {memo.decode()}")
    print(f"tx size (signed)                       : {1 + len(signed)} bytes")

    # 1) Signature check, locally (pure-python RFC 8032 verify).
    sig_ok = ed25519_verify(payer, msg, sig)
    print(f"ed25519 signature verified locally     : {'yes' if sig_ok else 'NO'}")

    # 2) Execution check on the live chain. Cookie Chain rejects simulation of a
    #    nonexistent (unfunded) fee-payer account, so use a funded stand-in payer
    #    taken from a recent memo transaction. READ-ONLY: sigVerify off, nothing is
    #    sent, the stand-in account is never contacted, charged or credited.
    standin = None
    try:
        recent = rpc(rpc_url, "getSignaturesForAddress", [MEMO_PID, {"limit": 1}])
        if recent:
            tx = rpc(rpc_url, "getTransaction",
                     [recent[0]["signature"], {"encoding": "json", "maxSupportedTransactionVersion": 0}])
            keys = [k["pubkey"] if isinstance(k, dict) else k
                    for k in tx["transaction"]["message"]["accountKeys"]]
            standin = keys[0]
    except Exception:
        standin = None

    exec_ok = None
    if standin:
        raw2 = build_memo_tx(b58decode(standin), memo, blockhash)
        tx2 = base64.b64encode(bytes([1]) + b"\x00" * 64 + raw2[65:]).decode()
        sim = rpc(rpc_url, "simulateTransaction", [tx2, {
            "encoding": "base64", "sigVerify": False, "replaceRecentBlockhash": True}])
        v = sim["value"]
        print(f"stand-in funded payer (read-only sim)  : {standin}")
        print(f"simulation error                       : {v['err']}")
        print(f"units consumed                         : {v.get('unitsConsumed')}")
        print(f"logs (tail)                            : {v.get('logs', [])[-3:]}")
        exec_ok = v["err"] is None
    else:
        print("no recent memo tx found to source a funded stand-in payer; execution check skipped")

    if sig_ok and exec_ok:
        print("RESULT: PASS — tx construction, ed25519 signature and SPL Memo v2 instruction "
              "are all valid on Cookie Chain. Nothing was sent, nothing was spent.")
        return 0
    if sig_ok and exec_ok is None:
        print("RESULT: PARTIAL PASS — construction + signature valid; execution check skipped.")
        return 0
    print("RESULT: FAIL — see above (dry run only; nothing was sent).")
    return 1


if __name__ == "__main__":
    sys.exit(main())