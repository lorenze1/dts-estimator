import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const [app,index,fn,netlify,manifest,worker,server]=await Promise.all([
  read('app.js'),read('index.html'),read('netlify/functions/generate.js'),read('netlify.toml'),read('manifest.webmanifest'),read('sw.js'),read('server.js')
]);

for(const template of ['Boiler Replacement','Mini Split Installation','RTU Replacement','Compressor Replacement','Chiller Repair','Pump Replacement','Cooling Tower','Leak Investigation','Condenser Replacement','Hot Water Tank Replacement','PM Findings','TSA Agreement','Small Proposal'])assert.ok(app.includes(template),`mobile selector preserves ${template}`);
for(const page of ['home','jobs','camera','settings'])assert.match(index,new RegExp(`data-page="${page}"`),`bottom navigation includes ${page}`);
for(const feature of ['projectSearch','intakeProgress','knowledgeProgress','missingQuestions','missingAnswers','albert.jobs','albert.knowledge','albert.intake'])assert.ok(`${app}\n${index}`.includes(feature),`V1.1 includes ${feature}`);
for(const category of ['Approved Proposal','Scope Template','Price Book','Warranty','Terms &amp; Conditions','SOP','Equipment Manual','Service Report','Brand Standard','Other'])assert.ok(index.includes(category),`Teach Albert includes ${category}`);
for(const feature of ['knowledgeFolder','webkitdirectory','knowledgeImages','knowledgeCamera','capture="environment"','teachQueued','knowledgeQueue','sourceCount','reusableStandards','approvedAt'])assert.ok(`${app}\n${index}`.includes(feature),`batch knowledge includes ${feature}`);
assert.match(fn,/process\.env\.ANTHROPIC_API_KEY/);
assert.doesNotMatch(`${app}\n${index}\n${netlify}\n${manifest}\n${worker}`,/sk-ant-[A-Za-z0-9_-]+/);
assert.doesNotMatch(`${app}\n${index}`,/ANTHROPIC_API_KEY/);
assert.match(fn,/https:\/\/api\.anthropic\.com\/v1\/messages/);
assert.match(fn,/ask at most 6 essential missing questions/);
assert.match(fn,/missingQuestions\.slice\(0,6\)/);
assert.match(fn,/needsReview/);
assert.match(fn,/confidence is below 0\.8/);
assert.match(fn,/Never guess obscured or unreadable words/);
assert.match(netlify,/functions = "netlify\/functions"/);
assert.match(netlify,/Content-Security-Policy/);
assert.equal(JSON.parse(manifest).display,'standalone');
assert.match(worker,/manifest\.webmanifest/);
assert.match(server,/templates:\['boiler'.*'small_proposal'\]/s);
console.log('Albert V1.1 audit checks passed');
