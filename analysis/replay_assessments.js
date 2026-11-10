'use strict';
// Re-score stored traces. Does not launch browsers or reproduce captured DOM events.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {assess}=require('../harness/run.js');
const root=path.resolve(__dirname,'..');
const groups=['variants','corpus','corpus_rerun','repaired',...['browser','browser-fixtures','browser-repaired','browser-contrast'].flatMap(group=>['chromium','firefox','webkit'].map(engine=>group+'/'+engine))];
let checked=0;
for(const group of groups)for(const file of fs.readdirSync(path.join(root,'results',group)).filter(f=>f.endsWith('.json')&&!f.startsWith('_'))){
 const relative='results/'+group+'/'+file;const record=JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));
 assert.deepEqual(assess(record.runs),record.assessment,relative);checked++;
}
assert.equal(checked,1004);console.log(JSON.stringify({status:'passed',stored_assessments_checked:checked,browser_experiments_rerun:0,AT_captures:0},null,2));
