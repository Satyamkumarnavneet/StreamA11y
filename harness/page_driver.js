'use strict';
// Page-side StreamA11y driver. It is serialized with Function.prototype.toString and executed inside a
// real browser page (Playwright page.evaluate) or inside a jsdom window (for the parity test), so it must
// be fully self-contained: no closures over Node variables, no require().
// It is a port of runScenario() in run.js. The differences are intentional and documented:
//   * the page under test lives in an <iframe> of the host page, so real layout, focus and rendering apply;
//   * focus is read from the engine (document.activeElement), and `engineLost` records the raw engine answer
//     before our own focus-fixup rule is applied;
//   * requestAnimationFrame is awaited after each action so the engine's own focus fixup has run;
//   * accessible names use a small approximation (aria-label, aria-labelledby, text, title, value).
async function driveInPage(arg) {
  const { scenario, html, consts } = arg;
  const { QUESTION, p1, p2, LATE, MARKERS, vocab } = consts;
  const CONTENT_VOCAB = new Set(vocab);
  const words = (s) => (s.toLowerCase().match(/[a-z]+/g) || []);
  const contentChars = (text) => words(text).filter((w) => CONTENT_VOCAB.has(w)).reduce((s, w) => s + w.length, 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let tick = 0;
  const events = [], streams = [], announcements = [], focusLog = [], errors = [], notes = [];
  const mark = (kind, extra = {}) => { const e = { k: tick++, kind, ...extra }; events.push(e); return e.k; };

  // ---- host-side SDK (the page under test calls parent.__streamSDK) ----
  window.__streamSDK = {
    streamChat(messages, handlers) {
      const s = { idx: streams.length, messages, handlers: handlers || {}, aborted: false };
      streams.push(s);
      events.push({ k: tick++, kind: 'sdk-call', stream: s.idx });
      return { abort() { s.aborted = true; events.push({ k: tick++, kind: 'sdk-abort', stream: s.idx }); } };
    }
  };

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'page under test');
  iframe.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:800px;border:0;background:#fff';
  document.body.appendChild(iframe);
  const win = iframe.contentWindow, doc = iframe.contentDocument;
  const result = { scenario, ok: true, notes, errors, events, announcements, focusLog };
  const prelude = '<script>window.ChatSDK=parent.__streamSDK;<\/script>';
  let page = html;
  if (/<head[^>]*>/i.test(page)) page = page.replace(/<head[^>]*>/i, (m) => m + prelude);
  else if (/<html[^>]*>/i.test(page)) page = page.replace(/<html[^>]*>/i, (m) => m + prelude);
  else page = prelude + page;
  if (consts.polyfill) { try { win.eval(consts.polyfill); } catch (e) { notes.push('polyfill: ' + e.message); } }
  win.addEventListener('error', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
  doc.open(); doc.write(page); doc.close();
  await new Promise((r) => { if (doc.readyState === 'complete') r(); else win.addEventListener('load', () => r()); setTimeout(r, 3000); });
  await sleep(60);

  const rafTwice = () => new Promise((r) => { let d = false; const f = () => { if (!d) { d = true; r(); } }; try { win.requestAnimationFrame(() => win.requestAnimationFrame(f)); } catch (e) {} setTimeout(f, 100); });

  // ---- live-region announcement model (identical rules to run.js) ----
  const knownRegions = new WeakSet();
  const pendingBusy = new Set();
  const isHidden = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hidden) return true;
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    return false;
  };
  const liveOf = (el) => {
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
  const observer = new win.MutationObserver((records) => {
    const atomicRegions = new Map(); const parts = new Map();
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.attributeName === 'aria-busy' && r.target.getAttribute('aria-busy') !== 'true') {
          for (const root of [...pendingBusy]) if (r.target === root || r.target.contains(root)) { pendingBusy.delete(root); if (root.isConnected && !isHidden(root)) atomicRegions.set(root, { politeness: liveOf(root)?.politeness || 'polite', why: 'busy-release' }); }
        }
        continue;
      }
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!target || !target.isConnected) continue;
      const lr = liveOf(target); if (!lr) continue;
      const { root, politeness } = lr;
      if (!knownRegions.has(root)) continue;
      if (isHidden(target)) continue;
      if (busyUp(target)) { pendingBusy.add(root); continue; }
      const relevant = (attrUp(target, root, 'aria-relevant') || 'additions text').split(/\s+/);
      const all = relevant.includes('all');
      const atomicAttr = attrUp(target, root, 'aria-atomic');
      const atomic = atomicAttr === null ? implicitAtomic(root) : atomicAttr === 'true';
      let changed = false; let txt = '';
      if (r.type === 'characterData' && (all || relevant.includes('text'))) { changed = true; txt = textOf(r.target); }
      if (r.type === 'childList') {
        if (r.addedNodes.length && (all || relevant.includes('additions') || relevant.includes('text'))) { changed = true; for (const n of r.addedNodes) if (!(n.nodeType === 1 && isHidden(n))) txt += ' ' + textOf(n); }
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

  // ---- focus ----
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
  const describe = (el) => (!el ? 'none' : el === doc.body ? 'body' : (el.id ? '#' + el.id : el.tagName.toLowerCase()));
  const checkpoint = async (label) => {
    await rafTwice();
    const el = doc.activeElement;
    const raw = describe(el);
    const engineLost = !el || el === doc.body || el === doc.documentElement;
    const lost = engineLost || !focusable(el);
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
    focusLog.push({ k: tick++, label, focus: raw, lost, engineLost, inTranscript, reason });
  };
  const transcriptText = () => {
    const walk = (n) => { if (n.nodeType === 3) return n.data; if (n.nodeType !== 1) return ''; if (isHidden(n) || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(n.tagName)) return ''; let s = ''; for (const c of n.childNodes) s += walk(c); return s; };
    return walk(doc.body).replace(/\s+/g, ' ');
  };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const accName = (e) => {
    if (!e) return '';
    const al = e.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
    const lb = e.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => n.textContent.trim()).join(' ').trim(); if (t) return t; }
    if (e.labels && e.labels.length) { const t = [...e.labels].map((l) => l.textContent.trim()).join(' ').trim(); if (t) return t; }
    const tx = (e.textContent || '').replace(/\s+/g, ' ').trim(); if (tx) return tx;
    return (e.getAttribute('title') || e.getAttribute('value') || '').trim();
  };

  let lastMut = Date.now();
  const quietObs = new win.MutationObserver(() => { lastMut = Date.now(); });
  const waitQuiet = async (quietMs = 60, maxMs = 1500) => { const s = Date.now(); await sleep(10); while (Date.now() - s < maxMs) { if (Date.now() - lastMut >= quietMs) return; await sleep(15); } };

  try {
    scanRegions();
    observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy'] });
    quietObs.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
    const el = (id) => doc.getElementById(id);
    const controls = { prompt: el('prompt'), send: el('send'), stop: el('stop'), regenerate: el('regenerate') };
    result.controls = Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, !!v]));
    if (!controls.prompt || !controls.send) { result.ok = false; notes.push('missing prompt or send control'); }
    else {
      const activate = (ctl) => {
        const e = el(ctl);
        const reach = { control: ctl, present: !!e, tabbable: tabbable(e), name: e ? accName(e) : '' };
        if (e) { try { e.focus(); } catch (x) {} try { e.click(); } catch (x) { errors.push('click ' + ctl + ': ' + x.message); } }
        mark('activate', { control: ctl, reach });
        return reach;
      };
      const type = (text) => {
        const p = el('prompt'); p.focus();
        if ('value' in p) p.value = text; else p.textContent = text;
        p.dispatchEvent(new win.Event('input', { bubbles: true }));
        p.dispatchEvent(new win.Event('change', { bubbles: true }));
      };
      const deliver = async (s, piece) => { if (!s) return; try { s.handlers.onToken && s.handlers.onToken(piece); } catch (x) { errors.push('onToken: ' + x.message); } mark('token', { stream: s.idx, piece }); await waitQuiet(40, 800); };
      const done = async (s) => { if (!s || s.aborted) return; mark('done', { stream: s.idx }); try { s.handlers.onDone && s.handlers.onDone(); } catch (x) { errors.push('onDone: ' + x.message); } await waitQuiet(150, 3000); };
      const fail = async (s) => { if (!s || s.aborted) return; mark('error', { stream: s.idx }); try { s.handlers.onError && s.handlers.onError(new win.Error('Network connection lost')); } catch (x) { errors.push('onError: ' + x.message); } await waitQuiet(150, 3000); };
      const sendQuestion = async () => {
        type(QUESTION);
        const before = streams.length;
        activate('send');
        await waitQuiet(60, 1000);
        await checkpoint('after-send');
        const s = streams[before];
        if (!s) { result.ok = false; notes.push('send did not call ChatSDK.streamChat'); }
        return s;
      };
      result.chunks = { v1: p1.length, v2: p2.length };
      let s = null;
      if (scenario === 'complete' || scenario === 'regenerate') {
        s = await sendQuestion();
        if (s) {
          for (let i = 0; i < p1.length; i++) { await deliver(s, p1[i]); if (i === 3) await checkpoint('mid-stream'); }
          await done(s); await checkpoint('after-done');
          result.textAfterV1 = transcriptText();
          if (scenario === 'regenerate') {
            const before = streams.length;
            result.regenReach = activate('regenerate');
            await waitQuiet(60, 1000); await checkpoint('after-regenerate');
            const s2 = streams[before];
            if (!s2) { result.regenFailed = true; notes.push('functional: regenerate did not start a new stream'); }
            else { for (let i = 0; i < p2.length; i++) { await deliver(s2, p2[i]); if (i === 3) await checkpoint('mid-regeneration'); } await done(s2); await checkpoint('after-done-2'); }
          }
        }
      } else if (scenario === 'stop' || scenario === 'race') {
        s = await sendQuestion();
        if (s) {
          for (let i = 0; i < 4; i++) await deliver(s, p1[i]);
          result.partial = norm(p1.slice(0, 4).join(''));
          result.stopReach = activate('stop');
          await waitQuiet(150, 3000); await checkpoint('after-stop');
          result.abortedAfterStop = s.aborted;
          result.textAfterStop = transcriptText();
          if (scenario === 'race') {
            const before = streams.length;
            result.regenReach = activate('regenerate');
            await waitQuiet(60, 1000); await checkpoint('after-regenerate');
            const s2 = streams[before];
            if (!s2) { result.regenFailed = true; notes.push('functional: regenerate did not start a new stream'); }
            if (s2) { await deliver(s2, p2[0]); await deliver(s2, p2[1]); }
            mark('late-token', { stream: s.idx });
            try { s.handlers.onToken && s.handlers.onToken(LATE); } catch (x) { errors.push('late onToken: ' + x.message); }
            await waitQuiet(60, 1000);
            if (s2) { for (let i = 2; i < p2.length; i++) await deliver(s2, p2[i]); await done(s2); await checkpoint('after-done-2'); }
          }
        }
      } else if (scenario === 'error') {
        s = await sendQuestion();
        if (s) {
          for (let i = 0; i < 4; i++) await deliver(s, p1[i]);
          result.partial = norm(p1.slice(0, 4).join(''));
          await fail(s); await checkpoint('after-error');
          result.textAfterError = transcriptText();
        }
      }
      await waitQuiet(200, 3000);
      result.finalText = transcriptText();
      result.busyLeft = [...doc.querySelectorAll('[aria-busy="true"]')].map(describe);
      // axe-core inside the page under test (source text is passed in consts.axeSource)
      win.eval(consts.axeSource);
      const run = async (rules) => (await win.axe.run(doc, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules, resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags.filter((t) => t.startsWith('wcag') || t === 'best-practice'), nodes: v.nodes.length }));
      result.axe = await run({ 'color-contrast': { enabled: false } });
      if (consts.contrast) result.axeWithContrast = await run({});
    }
  } catch (x) {
    result.ok = false; notes.push('harness exception: ' + String((x && x.stack) || x).slice(0, 400));
  }
  try { observer.disconnect(); quietObs.disconnect(); } catch (e) {}
  result.streams = streams.length;
  result.ms = Date.now() - t0;
  result.userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  try { iframe.remove(); } catch (e) {}
  return JSON.parse(JSON.stringify(result));
}

module.exports = { driveInPage };
