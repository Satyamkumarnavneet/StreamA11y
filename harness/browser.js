'use strict';
// Real-browser run of the StreamA11y benchmark with Playwright (Chromium, Firefox, WebKit).
// Usage:
//   node harness/browser.js --in=corpus/generated --out=results/browser [--engines=chromium,firefox,webkit]
//                           [--limit=N] [--only=substring] [--contrast]
// Output: one JSON per (engine, file) in <out>/<engine>/<file>.json, same schema as results/corpus plus engine info,
// and <out>/_run.json with versions and counts. Nothing is sent over the network (pages are loaded from memory).
const fs = require('fs');
const path = require('path');
const { assess, SCENARIOS, consts } = require('./run.js');
const { driveInPage } = require('./page_driver.js');

const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : def; };
const flag = (name) => process.argv.includes('--' + name);

async function main() {
  let playwright;
  try { playwright = require('playwright'); } catch (e) { console.error('Install first: npm install playwright && npx playwright install chromium firefox webkit'); process.exit(2); }
  const inDir = arg('in', 'corpus/generated');
  const outDir = arg('out', 'results/browser');
  const engines = arg('engines', 'chromium,firefox,webkit').split(',');
  const only = arg('only', '');
  const limit = parseInt(arg('limit', '0'), 10);
  let files = fs.readdirSync(inDir).filter((f) => f.endsWith('.html') && f.includes(only)).sort();
  if (limit) files = files.slice(0, limit);
  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const C = consts(); C.contrast = flag('contrast'); C.axeSource = axeSource;
  fs.mkdirSync(outDir, { recursive: true });
  const info = { started: new Date().toISOString(), playwright: require('playwright/package.json').version, inDir, files: files.length, engines: {} };

  for (const name of engines) {
    const type = playwright[name];
    if (!type) { console.error('unknown engine', name); continue; }
    const browser = await type.launch({ headless: true });
    info.engines[name] = { version: browser.version(), done: 0, incompatible: 0, errors: 0 };
    fs.mkdirSync(path.join(outDir, name), { recursive: true });
    console.log(`== ${name} ${browser.version()} : ${files.length} files`);
    for (const file of files) {
      const outFile = path.join(outDir, name, file.replace(/\.html$/, '.json'));
      if (fs.existsSync(outFile) && !flag('force')) { info.engines[name].done++; continue; }
      const html = fs.readFileSync(path.join(inDir, file), 'utf8');
      const runs = {};
      for (const sc of SCENARIOS) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        const page = await context.newPage();
        try {
          await page.goto('about:blank');
          runs[sc] = await Promise.race([
            page.evaluate(driveInPage, { scenario: sc, html, consts: C }),
            new Promise((r) => setTimeout(() => r({ scenario: sc, ok: false, notes: ['scenario timeout (90 s)'], errors: [], events: [], announcements: [], focusLog: [] }), 90000))
          ]);
        } catch (e) {
          runs[sc] = { scenario: sc, ok: false, notes: ['runner exception: ' + String(e.message).slice(0, 300)], errors: [], events: [], announcements: [], focusLog: [] };
          info.engines[name].errors++;
        }
        await context.close().catch(() => {});
      }
      const assessment = assess(runs);
      fs.writeFileSync(outFile, JSON.stringify({ file, engine: name, engineVersion: browser.version(), runs, assessment }));
      info.engines[name].done++;
      if (!assessment.compatible) info.engines[name].incompatible++;
      console.log(JSON.stringify({ engine: name, file, failures: assessment.failures, functional: assessment.functional, A: assessment.metrics.A && +assessment.metrics.A.toFixed(2), axe: assessment.axe.wcag }));
    }
    await browser.close();
  }
  info.finished = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, '_run.json'), JSON.stringify(info, null, 1));
  console.log('Done. Wrote', outDir);
}
main().catch((e) => { console.error(e); process.exit(1); });
