'use strict';
// StreamA11y lifecycle harness.
// Loads one self-contained chat UI (HTML file) in jsdom, drives a scripted streaming SDK through
// five lifecycle scenarios, and records (1) announcements submitted through ARIA live regions,
// (2) keyboard focus at fixed checkpoints, (3) transcript text, and (4) axe-core results on the final DOM.
// The harness never reads implementation labels; it only observes the page.
// Usage: node harness/run.js <file.html> [out.json]
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { computeAccessibleName } = require('dom-accessibility-api');

const QUESTION = 'Can you explain how this landform develops?';
// Answers use a content vocabulary that does not overlap with typical status words.
const V1 = 'River deltas form where flowing water slows near the sea, so carried sediment settles and builds layered ground over many centuries.';
const V2 = 'Glaciers carve broad valleys while packed ice creeps downhill, scraping bedrock and dragging boulders far from their original outcrops.';
const LATE = ' Meanwhile marshland lagoons widen.'; // late chunk from the stopped stream (marker words)
const CHUNK_WORDS = 2;
const chunk = (s) => { const w = s.split(' '); const out = []; for (let i = 0; i < w.length; i += CHUNK_WORDS) out.push((i ? ' ' : '') + w.slice(i, i + CHUNK_WORDS).join(' ')); return out; };
const words = (s) => (s.toLowerCase().match(/[a-z]+/g) || []);
const CONTENT_VOCAB = new Set([...words(V1), ...words(V2), ...words(LATE)].filter((w) => w.length > 3));
const MARKERS = ['marshland', 'lagoons'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function contentChars(text) { return words(text).filter((w) => CONTENT_VOCAB.has(w)).reduce((s, w) => s + w.length, 0); }

async function runScenario(html, scenario, opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
  const streams = [];
  const t0 = Date.now();
  let tick = 0; // logical event counter
  const events = []; // harness events: {k, kind, ...}
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://streama11y.test/', virtualConsole: vc,
    beforeParse(window) {
      // Polyfills for APIs jsdom lacks; none of them affect accessibility semantics.
      window.Element.prototype.scrollIntoView = function () {};
      window.Element.prototype.scrollTo = function () {};
      window.scrollTo = function () {};
      window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      if (!('innerText' in window.HTMLElement.prototype)) {
        Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
      }
      try { window.navigator.clipboard = { writeText: async () => {}, readText: async () => '' }; } catch (e) {}
      window.fetch = () => Promise.reject(new Error('network disabled in harness'));
      window.ChatSDK = {
        streamChat(messages, handlers) {
          const s = { idx: streams.length, messages, handlers: handlers || {}, aborted: false };
          streams.push(s);
          events.push({ k: tick++, kind: 'sdk-call', stream: s.idx });
          return { abort() { s.aborted = true; events.push({ k: tick++, kind: 'sdk-abort', stream: s.idx }); } };
        }
      };
    }
  });
  const { window } = dom;
  const doc = window.document;

  // ---------- Live-region announcement model (WAI-ARIA 1.2 semantics, simplified) ----------
  const announcements = [];
  const knownRegions = new WeakSet();
  const pendingBusy = new Set();
  const isHidden = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hidden) return true;
      const cs = window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    return false;
  };
  const liveOf = (el) => { // nearest live-region root and its politeness
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const al = n.getAttribute('aria-live');
      if (al === 'off') return null;
      if (al === 'polite' || al === 'assertive') return { root: n, politeness: al };
      const role = (n.getAttribute('role') || '').trim();
      if (role === 'status' || role === 'log') return { root: n, politeness: 'polite' };
      if (role === 'alert') return { root: n, politeness: 'assertive' };
      if (role === 'timer' || role === 'marquee') return null;
      if (n.tagName === 'OUTPUT') return { root: n, politeness: 'polite' };
    }
    return null;
  };
  const attrUp = (el, root, name) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const v = n.getAttribute(name); if (v !== null) return v; if (n === root) break; } return null; };
  const implicitAtomic = (root) => ['status', 'alert'].includes((root.getAttribute('role') || '').trim()) || root.tagName === 'OUTPUT';
  const busyUp = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.getAttribute('aria-busy') === 'true') return true; return false; };
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  const scanRegions = () => { doc.querySelectorAll('*').forEach((el) => { const lr = liveOf(el); if (lr && lr.root === el) knownRegions.add(el); }); };
  const emit = (root, politeness, text, why) => { if (text) announcements.push({ k: tick++, ms: Date.now() - t0, text, politeness, why, contentChars: contentChars(text) }); };

  const observer = new window.MutationObserver((records) => {
    const atomicRegions = new Map();
    const parts = new Map();
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.attributeName === 'aria-busy' && r.target.getAttribute('aria-busy') !== 'true') {
          for (const root of [...pendingBusy]) if (r.target === root || r.target.contains(root)) { pendingBusy.delete(root); if (root.isConnected && !isHidden(root)) atomicRegions.set(root, { politeness: liveOf(root)?.politeness || 'polite', why: 'busy-release' }); }
        }
        continue;
      }
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!target || !target.isConnected) continue;
      const lr = liveOf(target);
      if (!lr) continue;
      const { root, politeness } = lr;
      if (!knownRegions.has(root)) continue; // region inserted in this batch: content of new regions is not announced
      if (isHidden(target)) continue;
      if (busyUp(target)) { pendingBusy.add(root); continue; }
      const relevant = (attrUp(target, root, 'aria-relevant') || 'additions text').split(/\s+/);
      const all = relevant.includes('all');
      const atomicAttr = attrUp(target, root, 'aria-atomic');
      const atomic = atomicAttr === null ? implicitAtomic(root) : atomicAttr === 'true';
      let changed = false; let txt = '';
      if (r.type === 'characterData' && (all || relevant.includes('text'))) { changed = true; txt = textOf(r.target); }
      if (r.type === 'childList') {
        if (r.addedNodes.length && (all || relevant.includes('additions') || relevant.includes('text'))) {
          changed = true;
          for (const n of r.addedNodes) if (!(n.nodeType === 1 && isHidden(n))) txt += ' ' + textOf(n);
        }
        if (r.removedNodes.length && (all || relevant.includes('removals'))) { changed = true; for (const n of r.removedNodes) txt += ' ' + textOf(n); }
      }
      if (!changed) continue;
      if (atomic) atomicRegions.set(root, { politeness, why: 'atomic' });
      else { if (!parts.has(root)) parts.set(root, { politeness, text: [] }); parts.get(root).text.push(txt.trim()); }
    }
    for (const [root, v] of atomicRegions) emit(root, v.politeness, textOf(root), v.why);
    for (const [root, v] of parts) emit(root, v.politeness, v.text.filter(Boolean).join(' ').trim(), 'additions');
    scanRegions();
  });

  // ---------- Focus model (HTML focus fixup rule) ----------
  const focusable = (el) => {
    if (!el || el.nodeType !== 1 || !el.isConnected || isHidden(el)) return false;
    if (el.disabled || el.closest('[inert]')) return false;
    const tag = el.tagName;
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return true;
    if (tag === 'A' && el.hasAttribute('href')) return true;
    if (el.isContentEditable) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && !Number.isNaN(parseInt(ti, 10));
  };
  const tabbable = (el) => focusable(el) && !(el.getAttribute('tabindex') !== null && parseInt(el.getAttribute('tabindex'), 10) < 0);
  const focusLog = [];
  const describe = (el) => (!el ? 'none' : el === doc.body ? 'body' : (el.id ? '#' + el.id : el.tagName.toLowerCase()));
  const checkpoint = (label) => {
    let el = doc.activeElement;
    const raw = describe(el);
    const lost = !el || el === doc.body || el === doc.documentElement || !focusable(el);
    const log = doc.getElementById('log');
    const inTranscript = !!(el && el !== doc.body && el.closest && (el.closest('article') || (log && log.contains(el))) && !['BUTTON', 'A', 'INPUT', 'TEXTAREA'].includes(el.tagName));
    let reason = 'ok';
    if (!el || el === doc.body || el === doc.documentElement) reason = 'body';
    else if (!el.isConnected) reason = 'removed';
    else if (el.disabled) reason = 'disabled';
    else if (isHidden(el)) reason = 'hidden';
    else if (el.closest('[inert]')) reason = 'inert';
    else if (!focusable(el)) reason = 'not-focusable';
    if (inTranscript) reason = 'transcript';
    focusLog.push({ k: tick++, label, focus: raw, lost, engineLost: !el || el === doc.body || el === doc.documentElement, inTranscript, reason });
  };
  const transcriptText = () => {
    // Text exposed to assistive technology: skip hidden subtrees.
    const walk = (n) => { if (n.nodeType === 3) return n.data; if (n.nodeType !== 1) return ''; if (isHidden(n) || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(n.tagName)) return ''; let s = ''; for (const c of n.childNodes) s += walk(c); return s; };
    return walk(doc.body).replace(/\s+/g, ' ');
  };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  // Wait until the page stops mutating (covers typewriter effects and timers), bounded.
  let lastMut = Date.now();
  const quietObs = new window.MutationObserver(() => { lastMut = Date.now(); });
  const waitQuiet = async (quietMs = 60, maxMs = 1500) => { const s = Date.now(); await sleep(10); while (Date.now() - s < maxMs) { if (Date.now() - lastMut >= quietMs) return; await sleep(15); } };

  const result = { scenario, ok: true, notes: [], errors, events, announcements, focusLog };
  const mark = (kind, extra = {}) => { const e = { k: tick++, kind, ...extra }; events.push(e); return e.k; };
  try {
    await new Promise((r) => { if (doc.readyState === 'complete') r(); else window.addEventListener('load', r); });
    await sleep(30);
    scanRegions();
    observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy'] });
    quietObs.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
    const el = (id) => doc.getElementById(id);
    const controls = { prompt: el('prompt'), send: el('send'), stop: el('stop'), regenerate: el('regenerate') };
    result.controls = Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, !!v]));
    if (!controls.prompt || !controls.send) { result.ok = false; result.notes.push('missing prompt or send control'); return finalize(); }
    const activate = (ctl, name) => {
      const e = el(ctl);
      const reach = { control: ctl, present: !!e, tabbable: tabbable(e), name: e ? computeAccessibleName(e) : '' };
      if (e) { try { e.focus(); } catch (x) {} try { e.click(); } catch (x) { errors.push('click ' + ctl + ': ' + x.message); } }
      mark('activate', { control: ctl, reach });
      return reach;
    };
    const type = (text) => {
      const p = el('prompt');
      p.focus();
      if ('value' in p) p.value = text; else p.textContent = text;
      p.dispatchEvent(new window.Event('input', { bubbles: true }));
      p.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const deliver = async (s, piece) => { if (!s) return; try { s.handlers.onToken && s.handlers.onToken(piece); } catch (x) { errors.push('onToken: ' + x.message); } mark('token', { stream: s.idx, piece }); await waitQuiet(40, 800); };
    const done = async (s) => { if (!s || s.aborted) return; mark('done', { stream: s.idx }); try { s.handlers.onDone && s.handlers.onDone(); } catch (x) { errors.push('onDone: ' + x.message); } await waitQuiet(150, 3000); };
    const fail = async (s) => { if (!s || s.aborted) return; mark('error', { stream: s.idx }); try { s.handlers.onError && s.handlers.onError(new window.Error('Network connection lost')); } catch (x) { errors.push('onError: ' + x.message); } await waitQuiet(150, 3000); };
    const sendQuestion = async () => {
      type(QUESTION);
      const before = streams.length;
      activate('send');
      await waitQuiet(60, 1000);
      checkpoint('after-send');
      const s = streams[before];
      if (!s) { result.ok = false; result.notes.push('send did not call ChatSDK.streamChat'); }
      return s;
    };
    const p1 = chunk(V1), p2 = chunk(V2);
    result.chunks = { v1: p1.length, v2: p2.length };

    if (scenario === 'complete' || scenario === 'regenerate') {
      const s = await sendQuestion(); if (!s) return finalize();
      for (let i = 0; i < p1.length; i++) { await deliver(s, p1[i]); if (i === 3) checkpoint('mid-stream'); }
      await done(s);
      checkpoint('after-done');
      result.textAfterV1 = transcriptText();
      if (scenario === 'regenerate') {
        const before = streams.length;
        result.regenReach = activate('regenerate');
        await waitQuiet(60, 1000);
        checkpoint('after-regenerate');
        const s2 = streams[before];
        if (!s2) { result.regenFailed = true; result.notes.push('functional: regenerate did not start a new stream'); }
        else {
          for (let i = 0; i < p2.length; i++) { await deliver(s2, p2[i]); if (i === 3) checkpoint('mid-regeneration'); }
          await done(s2);
          checkpoint('after-done-2');
        }
      }
    } else if (scenario === 'stop' || scenario === 'race') {
      const s = await sendQuestion(); if (!s) return finalize();
      for (let i = 0; i < 4; i++) await deliver(s, p1[i]);
      result.partial = norm(p1.slice(0, 4).join(''));
      result.stopReach = activate('stop');
      await waitQuiet(150, 3000);
      checkpoint('after-stop');
      result.abortedAfterStop = s.aborted;
      result.textAfterStop = transcriptText();
      if (scenario === 'race') {
        const before = streams.length;
        result.regenReach = activate('regenerate');
        await waitQuiet(60, 1000);
        checkpoint('after-regenerate');
        const s2 = streams[before];
        if (!s2) { result.regenFailed = true; result.notes.push('functional: regenerate did not start a new stream'); }
        if (s2) { await deliver(s2, p2[0]); await deliver(s2, p2[1]); }
        // One in-flight chunk from the stopped stream arrives late (documented SDK behavior).
        mark('late-token', { stream: s.idx });
        try { s.handlers.onToken && s.handlers.onToken(LATE); } catch (x) { errors.push('late onToken: ' + x.message); }
        await waitQuiet(60, 1000);
        if (s2) {
          for (let i = 2; i < p2.length; i++) await deliver(s2, p2[i]);
          await done(s2);
          checkpoint('after-done-2');
        }
      }
    } else if (scenario === 'error') {
      const s = await sendQuestion(); if (!s) return finalize();
      for (let i = 0; i < 4; i++) await deliver(s, p1[i]);
      result.partial = norm(p1.slice(0, 4).join(''));
      await fail(s);
      checkpoint('after-error');
      result.textAfterError = transcriptText();
    }
    await waitQuiet(200, 3000);
    result.finalText = transcriptText();
    result.busyLeft = [...doc.querySelectorAll('[aria-busy="true"]')].map(describe);
    window.eval(axeSource);
    const axeRes = await window.axe.run(doc, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    result.axe = axeRes.violations.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags.filter((t) => t.startsWith('wcag') || t === 'best-practice'), nodes: v.nodes.length }));
  } catch (x) {
    result.ok = false; result.notes.push('harness exception: ' + (x && x.stack || x).toString().slice(0, 400));
  }
  return finalize();

  function finalize() {
    try { observer.disconnect(); quietObs.disconnect(); } catch (e) {}
    result.streams = streams.length;
    result.ms = Date.now() - t0;
    try { window.close(); } catch (e) {}
    return result;
  }
}

// ---------- Oracles ----------
function assess(runs) {
  const out = { checks: {}, metrics: {} };
  const fail = (id, bad, detail) => { if (!out.checks[id]) out.checks[id] = { fail: false, details: [] }; if (bad) { out.checks[id].fail = true; out.checks[id].details.push(detail); } };
  const after = (r, kind, idx = 0) => { const e = r.events.filter((x) => x.kind === kind)[idx]; return e ? e.k : null; };
  // Echo of the user's own message is not evidence that generation was exposed.
  const qn = QUESTION.toLowerCase().replace(/[^a-z ]/g, '');
  const isEcho = (x) => { const t = x.text.toLowerCase().replace(/[^a-z ]/g, ''); return t.includes(qn) && t.replace(qn, '').trim().length < 15; };
  const annBetween = (r, a, b) => r.announcements.filter((x) => x.k > a && (b === null || x.k < b) && !isEcho(x));
  for (const r of Object.values(runs)) {
    if (!r.ok) continue;
    const sdk = r.events.filter((e) => e.kind === 'sdk-call').map((e) => e.k);
    const firstActivate = after(r, 'activate');
    const stopBroken = (r.scenario === 'stop' || r.scenario === 'race') && r.abortedAfterStop === false;
    if (stopBroken) fail('stop-broken', true, { scenario: r.scenario });
    // Lifecycle silence: nothing at all submitted between Send and the end of the first answer (or stop/error).
    const end1 = r.scenario === 'complete' || r.scenario === 'regenerate' ? after(r, 'done') : r.scenario === 'error' ? after(r, 'error') : r.events.find((e) => e.kind === 'activate' && e.control === 'stop')?.k ?? null;
    fail('silent-start', annBetween(r, firstActivate, end1).length === 0, { scenario: r.scenario });
    // Terminal silence: nothing submitted after the terminal event.
    const term = r.scenario === 'error' ? after(r, 'error') : r.scenario === 'stop' ? r.events.find((e) => e.kind === 'activate' && e.control === 'stop')?.k : r.scenario === 'complete' ? after(r, 'done') : null;
    if (term !== null && term !== undefined && !(stopBroken && r.scenario === 'stop')) {
      const nextAct = r.events.find((e) => e.k > term && e.kind === 'activate');
      const stopAt = nextAct ? nextAct.k : null;
      const anns = annBetween(r, term, stopAt);
      fail('silent-terminal', anns.length === 0, { scenario: r.scenario });
    }
    // Regeneration start silence.
    if (r.regenFailed) fail('regenerate-broken', true, { scenario: r.scenario });
    if (r.scenario === 'regenerate' && !r.regenFailed) {
      const ra = r.events.find((e) => e.kind === 'activate' && e.control === 'regenerate')?.k;
      const d2 = r.events.filter((e) => e.kind === 'done')[1]?.k ?? null;
      fail('silent-start', annBetween(r, ra, d2).length === 0, { scenario: 'regenerate' });
    }
    // Focus: lost to body/unfocusable, or pulled into the transcript.
    for (const f of r.focusLog) fail('focus-lost', f.lost || f.inTranscript, { scenario: r.scenario, label: f.label, focus: f.focus, inTranscript: f.inTranscript, reason: f.reason });
    // Stop control reachable by keyboard and named.
    if (r.stopReach && !stopBroken) fail('stop-unreachable', !r.stopReach.present || !r.stopReach.tabbable || !r.stopReach.name, { reach: r.stopReach });
    // Partial answer retained and exposed after stop or error.
    if (r.scenario === 'stop') fail('partial-lost', !(r.textAfterStop || '').includes(r.partial) || !(r.finalText || '').includes(r.partial), { scenario: 'stop' });
    if (r.scenario === 'error') fail('partial-lost', !(r.textAfterError || '').includes(r.partial), { scenario: 'error' });
    // Stale-version leakage: late chunk text reaches the transcript or the announcement stream.
    if (r.scenario === 'race' && !stopBroken) {
      const lt = after(r, 'late-token');
      const inDom = MARKERS.some((m) => (r.finalText || '').toLowerCase().includes(m));
      const announced = r.announcements.some((a) => a.k > lt && MARKERS.some((m) => a.text.toLowerCase().includes(m)));
      fail('stale-leak', inDom || announced, { inDom, announced });
    }
    // Busy state released.
    fail('busy-stuck', (r.busyLeft || []).length > 0, { scenario: r.scenario, busyLeft: r.busyLeft });
    // Announcement load: content characters submitted per content character generated (first answer, complete scenario).
    if (r.scenario === 'complete') {
      const d = after(r, 'done');
      const submitted = r.announcements.filter((a) => a.k > firstActivate).reduce((s, a) => s + a.contentChars, 0);
      const generated = contentChars(V1);
      const A = submitted / generated;
      const contentAnns = r.announcements.filter((a) => a.k > firstActivate && a.k < d && a.contentChars > 0).length;
      out.metrics.A = A; out.metrics.contentAnnouncementsDuringStream = contentAnns;
      out.metrics.totalAnnouncements = r.announcements.length;
      fail('announcement-overload', A > 2, { A });
    }
  }
  // axe on final DOMs (union across scenarios)
  const axeIds = new Set(); const wcagIds = new Set();
  for (const r of Object.values(runs)) for (const v of r.axe || []) { axeIds.add(v.id); if (v.tags.some((t) => t.startsWith('wcag'))) wcagIds.add(v.id); }
  out.axe = { all: [...axeIds].sort(), wcag: [...wcagIds].sort() };
  out.compatible = Object.values(runs).every((r) => r.ok);
  out.incompatibleNotes = Object.values(runs).flatMap((r) => r.notes);
  const FUNCTIONAL = ['regenerate-broken', 'stop-broken'];
  out.failures = Object.entries(out.checks).filter(([, v]) => v.fail).map(([k]) => k).filter((k) => !FUNCTIONAL.includes(k)).sort();
  out.functional = FUNCTIONAL.filter((k) => out.checks[k]?.fail);
  return out;
}

const SCENARIOS = ['complete', 'stop', 'regenerate', 'race', 'error'];
async function runFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const runs = {};
  for (const sc of SCENARIOS) {
    const timeout = new Promise((r) => setTimeout(() => r({ scenario: sc, ok: false, notes: ['scenario timeout (60 s)'], errors: [], events: [], announcements: [], focusLog: [] }), 60000));
    runs[sc] = await Promise.race([runScenario(html, sc), timeout]);
  }
  return { file: path.basename(file), runs, assessment: assess(runs) };
}

const consts = () => ({ QUESTION, p1: chunk(V1), p2: chunk(V2), LATE, MARKERS, vocab: [...CONTENT_VOCAB] });
module.exports = { runFile, runScenario, assess, SCENARIOS, V1, V2, LATE, QUESTION, consts };

if (require.main === module) {
  (async () => {
    const files = process.argv.slice(2).filter((f) => f.endsWith('.html'));
    const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
    for (const f of files) {
      const res = await runFile(f);
      if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, path.basename(f, '.html') + '.json'), JSON.stringify(res)); }
      const a = res.assessment;
      console.log(JSON.stringify({ file: res.file, compatible: a.compatible, failures: a.failures, functional: a.functional, A: a.metrics.A && +a.metrics.A.toFixed(3), axeWcag: a.axe.wcag, axeAll: a.axe.all, notes: a.incompatibleNotes.slice(0, 2) }));
    }
    process.exit(0);
  })();
}
