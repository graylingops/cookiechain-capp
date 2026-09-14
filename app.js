// Cookie Jar — cApp on Cookie Chain (SVM)
// Single-page, buildless, vanilla JS + @solana/web3.js (ESM from esm.sh).
// All reads are free RPC calls; the only spend anywhere is a user-signed tx fee in COOK.
//
// GAS GATE: lifted 2026-09-13 — the sponsor COOK drip landed (100 COOK verified
// on-chain on the operator demo wallet via rpc.cookiescan.io), so the gate below
// was flipped to false (see README, "Current deployment status"). It can be
// re-armed only if the operator wallet runs out of gas again. Everything else
// runs for real:
// connect, address display, tx construction, FREE on-chain simulation
// (simulateTransaction is a read-only RPC call), confirmation polling, feed,
// dashboard. Any user wallet with its own COOK transacts normally, gate or not.

import {
  Connection, PublicKey, Transaction, TransactionInstruction,
  VersionedTransaction, Keypair, SystemProgram,
} from 'https://esm.sh/@solana/web3.js@1.98.2';
import bs58 from 'https://esm.sh/bs58@5.0.0';

// ---------------------------------------------------------------- constants
const RPC_URL = 'https://rpc.cookiescan.io';
const EXPECTED_GENESIS = '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2'; // Cookie Chain mainnet
const MEMO_PID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'); // SPL Memo v2 (executable on Cookie Chain)
const MEMO_TAG = 'cookiejar:v1';
const KINDS = ['bake', 'taste', 'tip'];
const EXPLORER_TX = 'https://cookiescan.io/tx/';
const ENCODER = new TextEncoder();

// Operator demo gate: applies ONLY to the operator demo wallet below (the
// wallet that records this deployment's demo transactions). GATED OFF since
// 2026-09-13: the sponsor COOK drip landed, so `active` is false and the
// operator wallet transacts like any other funded wallet. Never commit key
// material — connect via the wallet UI, do not hardcode secrets here.
const OPERATOR_DEMO_WALLET = '5kstYS2Wo4rdxETkw3wADLWGFm4gGsWk32FALUTDBMAn';
const GAS_GATE = {
  active: false,
  reason: 'The operator demo wallet gas gate was lifted on 2026-09-13 after the ' +
          'sponsor COOK drip landed. All funded wallets transact normally.',
  appliesTo(pubkey) {
    return this.active && !!pubkey && pubkey.toBase58() === OPERATOR_DEMO_WALLET;
  },
};

const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

// ---------------------------------------------------------------- dom utils
const $ = (id) => document.getElementById(id);
const show = (el, cls, html) => { el.className = cls; el.innerHTML = html; el.hidden = false; };
const hide = (el) => { el.hidden = true; };
const short = (a, n = 4) => a.slice(0, n) + '…' + a.slice(-n);
const fmtInt = (n) => new Intl.NumberFormat('en-US').format(n);

// ---------------------------------------------------------------- state
let provider = null;      // detected wallet provider
let walletPubkey = null;  // PublicKey | null
let latestTx = null;      // last built Transaction (for preview/simulate)
let pollTimer = null;

// ---------------------------------------------------------------- chain info
async function initChainInfo() {
  try {
    const [genesis, epochInfo, version] = await Promise.all([
      conn.getGenesisHash(), conn.getEpochInfo(), conn.getVersion(),
    ]);
    $('genesis').textContent = genesis;
    $('api-ver').textContent = (version['solana-core'] || '?') +
      ` · epoch ${epochInfo.epoch} · ${fmtInt(epochInfo.transactionCount)} txs`;
    if (genesis !== EXPECTED_GENESIS) {
      show($('net-banner'), 'bad',
        '<b>Wrong network.</b> This app targets Cookie Chain (genesis ' +
        `<code>${EXPECTED_GENESIS.slice(0, 8)}…</code>) but the RPC at <code>${RPC_URL}</code> ` +
        'answered with a different genesis. Do NOT sign anything until this is resolved.');
    }
  } catch (e) {
    show($('net-banner'), 'bad',
      `<b>RPC unreachable:</b> ${esc(e.message)}. Reads (feed, dashboard, simulation) are down; ` +
      'transacting would be unsafe — check your connection or the chain status at cookiescan.io.');
  }
}

// ---------------------------------------------------------------- wallet
function detectProvider() {
  // Nightly is the brief's required wallet; it injects window.nightly.solana.
  if (window.nightly && window.nightly.solana) {
    const p = window.nightly.solana;
    p.isNightly = true;
    return p;
  }
  // Fall back to any standard Solana-style injected provider.
  if (window.solana && (window.solana.isPhantom || window.solana.connect)) return window.solana;
  return null;
}

async function connect() {
  const msg = $('wallet-msg');
  provider = detectProvider();
  if (!provider) {
    show(msg, 'warn',
      '<b>No Nightly (or standard SVM) wallet detected.</b> Install Nightly from ' +
      '<a href="https://nightly.app">nightly.app</a>, then in its network settings add a custom ' +
      `SVM network with RPC <code>${RPC_URL}</code> and select it here. This page cannot and will ` +
      'not hold keys for you.');
    return;
  }
  try {
    await provider.connect();
    walletPubkey = new PublicKey(provider.publicKey.toString());
    onWalletConnected();
    show(msg, 'ok', `Connected via <b>${provider.isNightly ? 'Nightly' : (provider.providerName || 'wallet')}</b>.`);
  } catch (e) {
    walletPubkey = null;
    onWalletDisconnected();
    show(msg, 'bad', `<b>Connect failed:</b> ${esc(errText(e))}`);
  }
}

function disconnect() {
  try { provider && provider.disconnect && provider.disconnect(); } catch { /* ignore */ }
  walletPubkey = null;
  hide($('wallet-msg'));
  onWalletDisconnected();
}

function onWalletConnected() {
  $('addr').textContent = walletPubkey.toBase58();
  $('addr-row').hidden = false;
  $('btn-disconnect').disabled = false;
  $('btn-connect').textContent = 'Reconnect';
  $('wallet-state').textContent = 'connected · ' + short(walletPubkey.toBase58());
  // Address display is a required feature; balance read is free.
  conn.getBalance(walletPubkey).then((lam) => {
    $('bal-row').hidden = false;
    $('bal').textContent = (lam / 1e9).toFixed(6);
  }).catch(() => { $('bal-row').hidden = true; });
  updateButtons();
  loadFeed();
}

function onWalletDisconnected() {
  $('addr-row').hidden = true;
  $('bal-row').hidden = true;
  $('btn-disconnect').disabled = true;
  $('btn-connect').textContent = 'Connect wallet';
  $('wallet-state').textContent = 'not connected';
  updateButtons();
}

function updateButtons() {
  $('btn-simulate').disabled = !latestTx;
  $('btn-send').disabled = !latestTx || !walletPubkey || GAS_GATE.appliesTo(walletPubkey);
}

// ---------------------------------------------------------------- tx construction
// Memo payload: cookiejar:v1|<kind>|<note>
function buildMemoString(kind, note) {
  return `${MEMO_TAG}|${kind}|${note}`;
}

function buildMemoTx(kind, note, payer) {
  const memo = buildMemoString(kind, note);
  const bytes = ENCODER.encode(memo);
  if (bytes.length > 400) throw new Error(`memo too large (${bytes.length} bytes; the on-chain limit is 400 bytes — roughly 200 plain Latin characters, less for emoji or multi-byte scripts)`);
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  // SPL Memo (MemoSq4gq…): the instruction data IS the memo string, byte for byte.
  const data = bytes;
  const tx = new Transaction().add(new TransactionInstruction({
    programId: MEMO_PID,
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
    data,
  }));
  return tx;
}

function previewTx() {
  const kind = $('kind').value;
  const note = $('note').value.trim();
  const payer = walletPubkey || PLACEHOLDER_PAYER;
  try {
    latestTx = buildMemoTx(kind, note, payer);
    $('memo-preview').textContent = buildMemoString(kind, note);
    // serializeMessage() refuses to serialize a tx with no recent blockhash —
    // and at preview time none is fetched yet. Give the preview a placeholder
    // blockhash purely so the message size can be computed. simulate() and
    // send() both overwrite recentBlockhash with a fresh one from the RPC
    // before anything is simulated or signed, so this placeholder never
    // reaches the chain.
    if (!latestTx.recentBlockhash) {
      latestTx.recentBlockhash = PLACEHOLDER_BLOCKHASH;
    }
    if (!latestTx.feePayer) {
      latestTx.feePayer = payer;
    }
    const msgLen = latestTx.serializeMessage().length;
    $('tx-size').textContent = `message ${msgLen} B · payer ${short(payer.toBase58())}`;
    show($('sim-msg'), 'ok', 'Transaction built (unsigned). Use <b>Simulate</b> for a free, ' +
      'fee-less dry run against the live chain, or <b>Sign &amp; send</b> to execute.');
  } catch (e) {
    latestTx = null;
    $('memo-preview').textContent = '—';
    $('tx-size').textContent = '';
    show($('sim-msg'), 'bad', `<b>Cannot build transaction:</b> ${esc(e.message)}`);
  }
  updateButtons();
}

// Placeholder payer used only to shape the preview when no wallet is connected.
// It is a well-known all-zero address; it can never sign or spend anything.
const PLACEHOLDER_PAYER = new PublicKey('11111111111111111111111111111111');

// Placeholder recent blockhash, preview-time only (see previewTx): needed so the
// unsigned message can be measured. Never used for simulation, signing or send.
const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

// ---------------------------------------------------------------- simulate (free)
async function simulate() {
  if (!latestTx) return;
  const msg = $('sim-msg');
  show(msg, 'muted', 'Simulating on the live chain (read-only, no fee)…');
  try {
    // Simulation is a free read-only call, but Cookie Chain (like other SVM
    // chains without rent-exemption-on-simulate) rejects a simulation whose fee
    // payer account does not exist on-chain ("AccountNotFound") — and a
    // throwaway unfunded keypair would hit exactly that. Use the connected
    // wallet as the simulated fee payer when one is connected (nothing is
    // signed by it and nothing is charged — sigVerify is off), falling back to
    // the in-memory throwaway keypair only when no wallet is connected.
    const burn = Keypair.generate();
    const { blockhash } = await conn.getLatestBlockhash();
    latestTx.recentBlockhash = blockhash;
    latestTx.feePayer = walletPubkey || burn.publicKey;
    const vtx = new VersionedTransaction(latestTx.compileMessage());
    if (!walletPubkey) {
      // No connected wallet: fee payer is the throwaway keypair, so give the
      // simulation a real (throwaway) signature.
      vtx.sign([burn]);
    }
    // With a connected wallet the placeholder all-zero signature slot is left
    // as-is; sigVerify is off, so the RPC does not check signatures at all.
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      show(msg, 'bad', `<b>Simulation FAILED on-chain:</b> <code>${esc(JSON.stringify(sim.value.err))}</code>` +
        (sim.value.logs ? `<br><span class="addr">${esc(sim.value.logs.join('\n'))}</span>` : ''));
    } else {
      show(msg, 'ok',
        `<b>Simulation passed</b> — this exact instruction is valid on Cookie Chain. ` +
        `Units consumed: ${sim.value.unitsConsumed ?? '?'} · logs: <span class="addr">${esc((sim.value.logs || []).slice(-3).join(' | '))}</span>. ` +
        'No fee was charged (simulation is a free read).');
    }
  } catch (e) {
    show(msg, 'bad', `<b>Simulation error:</b> ${esc(errText(e))}`);
  }
}

// ---------------------------------------------------------------- send + confirm
async function send() {
  if (!latestTx || !walletPubkey) return;
  if (GAS_GATE.appliesTo(walletPubkey)) { // belt and braces: the button is disabled anyway
    show($('conf-card'), 'warn', `<b>Gas gate active (operator demo wallet):</b> ${esc(GAS_GATE.reason)}`);
    $('conf-card').hidden = false;
    return;
  }
  const body = $('conf-body');
  $('conf-card').hidden = false;
  show(body, 'muted', 'Requesting wallet signature…');
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    latestTx.recentBlockhash = blockhash;
    latestTx.feePayer = walletPubkey;
    let sig;
    if (provider.signAndSendTransaction) {
      const res = await provider.signAndSendTransaction(latestTx);
      sig = typeof res === 'string' ? res : res.signature;
    } else if (provider.signTransaction) {
      const signed = await provider.signTransaction(latestTx);
      sig = await conn.sendRawTransaction(signed.serialize());
    } else {
      throw new Error('wallet cannot sign transactions');
    }
    await pollConfirmation(sig, blockhash, lastValidBlockHeight);
  } catch (e) {
    show(body, 'bad', `<b>Transaction failed to send:</b> ${esc(errText(e))}` +
      '<br><span class="muted">Nothing was spent unless the wallet signed. Common causes: ' +
      'wallet rejection, wrong network selected in the wallet, or no COOK for the fee.</span>');
  }
}

function pollConfirmation(sig, blockhash, lastValidBlockHeight) {
  const body = $('conf-body');
  if (pollTimer) clearInterval(pollTimer);
  const t0 = Date.now();
  show(body, 'muted', `Sent. Signature: <span class="addr">${sig}</span><br>` +
    `Waiting for confirmation… <a href="${EXPLORER_TX}${sig}" target="_blank" rel="noopener">open in cookiescan.io</a>`);
  let stage = 0;
  pollTimer = setInterval(async () => {
    const secs = Math.round((Date.now() - t0) / 1000);
    try {
      const [res, expired] = await Promise.all([
        conn.getSignatureStatuses([sig], { searchTransactionHistory: true }),
        conn.getBlockHeight({ commitment: 'confirmed' }).then((h) => h > lastValidBlockHeight),
      ]);
      const st = res && res.value && res.value[0];
      if (st && st.err) {
        clearInterval(pollTimer);
        show(body, 'bad', `<b>Transaction failed on-chain:</b> <code>${esc(JSON.stringify(st.err))}</code> ` +
          `<a href="${EXPLORER_TX}${sig}" target="_blank" rel="noopener">explorer</a>`);
      } else if (st && st.confirmationStatus) {
        const lvl = { processed: 1, confirmed: 2, finalized: 3 }[st.confirmationStatus] || 0;
        if (lvl > stage) {
          stage = lvl;
          if (lvl >= 2) {
            show(body, 'ok',
              `<b>Confirmed${lvl === 3 ? ' + finalized' : ''}</b> in ${secs}s · slot ${st.slot} · ` +
              `signature <span class="addr">${sig}</span><br>` +
              `Your cookie is on Cookie Chain: <a href="${EXPLORER_TX}${sig}" target="_blank" rel="noopener">view on cookiescan.io</a>`);
            clearInterval(pollTimer);
            loadFeed(); // refresh the dashboard with the new tx
          } else {
            show(body, 'muted', `Sent ${secs}s ago · ${st.confirmationStatus} · slot ${st.slot} · ` +
              `<a href="${EXPLORER_TX}${sig}" target="_blank" rel="noopener">explorer</a>`);
          }
        }
      } else if (expired) {
        clearInterval(pollTimer);
        show(body, 'bad', `<b>Blockhash expired</b> after ${secs}s with no confirmation — the tx likely ` +
          'dropped (fee too low or RPC congestion). Nothing is confirmed; try again.');
      }
    } catch (e) {
      show(body, 'muted', `Polling… (${esc(errText(e))}) — will retry`);
    }
  }, 2000);
}

// ---------------------------------------------------------------- feed + stats
async function loadFeed() {
  const feed = $('feed');
  const tracked = await loadTracked();
  const wallets = [...new Set([...tracked.map((t) => t.address),
    ...(walletPubkey ? [walletPubkey.toBase58()] : [])])];
  feed.innerHTML = '<li class="muted">reading recent activity from the RPC…</li>';
  try {
    const sigLists = await Promise.all(wallets.map((a) =>
      conn.getSignaturesForAddress(new PublicKey(a), { limit: 25 })
        .catch(() => [])));
    const bySig = new Map();
    sigLists.forEach((l) => l.forEach((s) => { if (!bySig.has(s.signature)) bySig.set(s.signature, s); }));
    const sigs = [...bySig.values()].sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0)).slice(0, 40);
    const txs = await pmap(sigs, (s) =>
      conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null), 5);
    const rows = [];
    txs.forEach((tx, i) => {
      if (!tx || tx.meta && tx.meta.err) return;
      const memoData = extractMemo(tx);
      const parsed = parseMemo(memoData);
      if (!parsed) return;
      const st = sigs[i];
      // accountKeys[0] can be a PublicKey object (web3.js-parsed response) or a
      // plain base58 string (raw json encoding) — String() handles both and
      // yields the address; the elements never carry a .pubkey property, so
      // reading [0].pubkey would yield undefined and crash the row render.
      // Versioned (v0) messages carry staticAccountKeys instead.
      const who = tx.transaction.message.accountKeys
        ? String(tx.transaction.message.accountKeys[0])
        : String(tx.transaction.message.staticAccountKeys?.[0] || '');
      rows.push({ ...parsed, who, sig: st.signature, time: st.blockTime, slot: st.slot });
    });
    if (!rows.length) {
      feed.innerHTML = '<li class="muted">No <code>cookiejar:v1</code> memos found yet in the recent ' +
        'history of the tracked wallets' + (walletPubkey ? ' or yours' : '') + '. Be the first — ' +
        'connect a funded wallet and bake one. (Tracked wallets: ' +
        (tracked.length ? tracked.map((t) => short(t.address)).join(', ') : 'none yet — participants.json is open') + '.)</li>';
    } else {
      feed.innerHTML = rows.map((r) =>
        `<li><b>${esc(r.kind)}</b> — ${esc(r.note)} · <span class="muted">${esc(short(r.who))} · ` +
        `${new Date(r.time * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z · slot ${r.slot} · ` +
        `<a href="${EXPLORER_TX}${r.sig}" target="_blank" rel="noopener">tx</a></li>`).join('');
    }
    renderStats(rows);
  } catch (e) {
    feed.innerHTML = `<li class="bad">Feed error: ${esc(errText(e))}</li>`;
  }
}

async function loadTracked() {
  try {
    const r = await fetch('participants.json', { cache: 'no-store' });
    const j = await r.json();
    return (j.wallets || []).filter((w) => typeof w.address === 'string');
  } catch { return []; }
}

function extractMemo(tx) {
  const ix = tx.transaction.message.instructions || [];
  const pid = MEMO_PID.toBase58();
  for (const i of ix) {
    const p = i.programId ? String(i.programId) : (tx.transaction.message.staticAccountKeys ? tx.transaction.message.staticAccountKeys[i.programIdIndex].toBase58() : null);
    if (p === pid) return bs58.decode(i.data);
  }
  return null;
}

function parseMemo(bytes) {
  if (!bytes) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const parts = text.split('|');
  if (parts[0] !== MEMO_TAG || !KINDS.includes(parts[1])) return null;
  return { kind: parts[1], note: (parts.slice(2).join('|') || '').slice(0, 200) };
}

async function pmap(items, fn, limit) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------------------------------------------------------------- dashboard
function renderStats(rows) {
  const now = Math.floor(Date.now() / 1000);
  const day = rows.filter((r) => now - (r.time || 0) < 86400);
  const bakers = new Set(rows.map((r) => r.who)).size;
  const tiles = [
    { k: 'jar memos seen (recent window)', v: fmtInt(rows.length) },
    { k: 'bakers', v: fmtInt(bakers) },
    { k: 'last 24h', v: fmtInt(day.length) },
    { k: 'latest slot', v: rows.length ? fmtInt(rows[0].slot) : '—' },
  ];
  $('tiles').innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="v">${t.v}</div><div class="k">${t.k}</div></div>`).join('');
  drawChart(day, now);
}

// Single-series bar chart: memos per hour, last 24h. Palette validated with the
// dataviz validator (light #2a78d6 / dark #3987e5, surface-checked).
function drawChart(day, now) {
  const svg = $('chart');
  const bins = new Array(24).fill(0);
  day.forEach((r) => {
    const h = 23 - Math.floor((now - (r.time || now)) / 3600);
    if (h >= 0 && h < 24) bins[h] += 1;
  });
  const W = svg.clientWidth || 780, H = 150, PL = 30, PB = 22, PT = 10;
  const iw = (W - PL - 8) / 24;
  const max = Math.max(1, ...bins);
  const series = getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim() || '#2a78d6';
  const grid = 'currentColor';
  let bars = '', labels = '', hits = '';
  bins.forEach((v, i) => {
    const x = PL + i * iw;
    const h = v / max * (H - PT - PB);
    const y = H - PB - h;
    bars += `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, iw - 2).toFixed(1)}" ` +
      `height="${h.toFixed(1)}" rx="2" fill="${series}"></rect>`;
    if (i % 4 === 0) labels += `<text x="${x.toFixed(1)}" y="${H - 6}" class="ax" text-anchor="middle">-${23 - i}h</text>`;
    hits += `<rect x="${x.toFixed(1)}" y="0" width="${iw.toFixed(1)}" height="${H}" fill="transparent" data-h="${23 - i}" data-v="${v}"></rect>`;
  });
  svg.innerHTML =
    `<line x1="${PL}" y1="${H - PB}" x2="${W - 4}" y2="${H - PB}" stroke="${grid}" stroke-opacity=".25"></line>` +
    `<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H - PB}" stroke="${grid}" stroke-opacity=".25"></line>` +
    `<text x="4" y="${PT + 8}" class="ax">${max}</text>` + bars + labels + hits;
  $('chart-table').innerHTML = '<tr><th>hours ago</th><th>memos</th></tr>' +
    bins.map((v, i) => `<tr><td>-${23 - i}h</td><td>${v}</td></tr>`).join('');
  const tip = $('tip');
  svg.querySelectorAll('rect[data-v]').forEach((r) => {
    r.addEventListener('mousemove', (ev) => {
      tip.textContent = `${r.dataset.h}h ago: ${r.dataset.v} memo${r.dataset.v === '1' ? '' : 's'}`;
      tip.style.display = 'block';
      const wrap = svg.parentElement.getBoundingClientRect();
      tip.style.left = (ev.clientX - wrap.left + 10) + 'px';
      tip.style.top = (ev.clientY - wrap.top - 24) + 'px';
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// ---------------------------------------------------------------- misc
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function errText(e) { return e && (e.message || JSON.stringify(e)) || String(e); }

function copyAddr() {
  navigator.clipboard && navigator.clipboard.writeText($('addr').textContent).then(() => {
    const b = $('btn-copy-addr'); b.textContent = 'copied';
    setTimeout(() => { b.textContent = 'copy'; }, 1200);
  });
}

// ---------------------------------------------------------------- wire up
$('pid').textContent = MEMO_PID.toBase58();
$('pid2').textContent = MEMO_PID.toBase58();
if (GAS_GATE.active) $('gas-gate').hidden = false;
$('btn-connect').addEventListener('click', connect);
$('btn-disconnect').addEventListener('click', disconnect);
$('btn-copy-addr').addEventListener('click', copyAddr);
$('btn-simulate').addEventListener('click', simulate);
$('btn-send').addEventListener('click', send);
$('note').addEventListener('input', previewTx);
$('kind').addEventListener('change', previewTx);
$('reload-feed').addEventListener('click', (e) => { e.preventDefault(); loadFeed(); });
previewTx();          // initial (placeholder-payer) preview
initChainInfo();      // genesis / epoch / version, wrong-network guard
loadFeed();           // dashboard renders even before any wallet connects
window.addEventListener('resize', () => { try { renderStats(renderStats._rows || []); } catch {} });
renderStats._rows = [];
const _origRender = renderStats;
renderStats = (rows) => { renderStats._rows = rows; _origRender(rows); };