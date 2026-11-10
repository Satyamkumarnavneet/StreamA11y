'use strict';
// Parity test: run the real-browser page driver inside a jsdom host page and compare its verdicts with the
// original jsdom harness (run.js). If they agree, the browser port is faithful, and differences seen in real
// browsers come from the engines, not from the port.
// Usage: node harness/parity_test.js <file.html> ...
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { runFile, assess, SCENARIOS, consts } = require('./run.js');
const { driveInPage } = require('./page_driver.js');
const AXE_MIN = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const POLY = `
Element.prototype.scrollIntoView = function () {}; Element.prototype.scrollTo = function () {}; window.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
if (!('innerText' in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
try { navigator.clipboard = { writeText: async () => {}, readText: async () => '' }; } catch (e) {}
window.fetch = () => Promise.reject(new Error('network disabled in harness'));`;

async function viaPageDriver(html) {
  const runs = {};
  for (const sc of SCENARIOS) {
    const host = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://streama11y.test/' });
    const w = host.window;
    const fn = w.eval('(' + driveInPage.toString() + ')');
    const C = { ...consts(), polyfill: POLY, axeSource: AXE_MIN };
    runs[sc] = await fn({ scenario: sc, html, consts: C });
    w.close();
  }
  return { runs, assessment: assess(runs) };
}

(async () => {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const html = fs.readFileSync(f, 'utf8');
    const a = (await runFile(f)).assessment;
    const b = (await viaPageDriver(html)).assessment;
    const same = a.compatible === b.compatible && b.compatible && JSON.stringify(a.failures) === JSON.stringify(b.failures) && JSON.stringify(a.functional) === JSON.stringify(b.functional)
      && JSON.stringify(a.axe) === JSON.stringify(b.axe) && Math.abs((a.metrics.A || 0) - (b.metrics.A || 0)) < 1e-9;
    if (!same) bad++;
    console.log(same ? 'SAME ' : 'DIFF ', path.basename(f), same ? '' : JSON.stringify({ jsdom: [a.failures, a.functional, a.metrics.A, a.incompatibleNotes], driver: [b.failures, b.functional, b.metrics.A, b.incompatibleNotes] }));
  }
  console.log(bad ? `${bad} files differ` : 'all files agree');
  process.exit(bad ? 1 : 0);
})();
