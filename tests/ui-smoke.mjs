import assert from 'node:assert/strict';
import {chromium} from '/Users/lorenzelanier/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
for(const viewport of [{name:'mobile',width:390,height:844},{name:'desktop',width:1280,height:900}]){
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  let knowledgeCalls=0;
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')browserErrors.push(message.text())});
  page.setDefaultTimeout(7000);
  await page.route('**/.netlify/functions/generate',async route=>{
    const request=route.request(),body=JSON.parse(request.postData()||'{}');
    if(body.action==='intake')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({projectType:'RTU Replacement',summary:'Replace rooftop unit',extractedFields:{equipment:'RTU'},missingQuestions:['What is the electrical service?']})});
    if(body.action==='proposal')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({proposal:'Scope of Work\nReplace rooftop unit.\nAssumption: verify electrical service.'})});
    knowledgeCalls++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({knowledge:{standards:['Use approved startup checklist'],warrantyTerms:[],exclusions:[]}})});
  });
  await page.goto('http://127.0.0.1:4173',{waitUntil:'networkidle'});
  assert.equal(await page.locator('nav button').count(),4,`${viewport.name}: four bottom navigation items`);
  await page.getByRole('button',{name:/New Proposal/}).click();
  await page.locator('#projectSearch').fill('TSA');
  await page.getByRole('button',{name:/TSA Agreement/}).click();
  await page.locator('#customer').fill('Test Building');
  await page.locator('#description').fill('Replace a rooftop unit and reuse the existing curb.');
  await page.locator('#analyzeBtn').click();
  await page.locator('#saveDraft').click();
  await page.locator('[data-missing-answer="0"]').fill('460V, three phase');
  await page.locator('#generateProposal').click();
  await page.waitForFunction(()=>document.querySelector('#proposalText')?.value.includes('Scope of Work'));
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('albert.jobs'))[0]);
  assert.equal(stored.missingAnswers[0],'460V, three phase',`${viewport.name}: missing answer persists`);
  assert.match(stored.proposal,/Replace rooftop unit/,`${viewport.name}: generated proposal persists`);
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.locator('#reviewCustomer').inputValue(),'Test Building',`${viewport.name}: active draft restores`);
  await page.locator('nav [data-page="settings"]').click();
  assert.equal(await page.locator('#knowledge').getAttribute('multiple'),'',`${viewport.name}: Teach Albert accepts multiple files`);
  assert.equal(await page.locator('#knowledgeFolder').getAttribute('webkitdirectory'),'',`${viewport.name}: folder picker is available where supported`);
  await page.locator('#openTeachAlbert').click();
  await page.locator('#knowledgeCategory').selectOption({label:'SOP'});
  await page.locator('#knowledge').setInputFiles([
    {name:'startup.txt',mimeType:'text/plain',buffer:Buffer.from('Use the approved startup checklist.')},
    {name:'closeout.txt',mimeType:'text/plain',buffer:Buffer.from('Document final operating conditions.')}
  ]);
  await page.waitForFunction(()=>document.querySelectorAll('.queue-row').length===2);
  assert.equal(knowledgeCalls,0,`${viewport.name}: staging does not teach before confirmation`);
  assert.match(await page.locator('.queue-row').first().innerText(),/SOP.*Ready/s,`${viewport.name}: queued category and status are visible`);
  await page.reload({waitUntil:'networkidle'});
  await page.locator('nav [data-page="settings"]').click();
  await page.locator('#openTeachAlbert').click();
  await page.waitForFunction(()=>document.querySelectorAll('.queue-row').length===2);
  assert.equal(await page.locator('.queue-row').count(),2,`${viewport.name}: staged queue persists across refresh`);
  await page.locator('#teachQueued').click();
  await page.waitForFunction(()=>document.querySelector('#knowledgeCount')?.textContent==='2');
  assert.equal(knowledgeCalls,2,`${viewport.name}: explicit confirmation processes the staged batch`);
  const trained=await page.evaluate(()=>JSON.parse(localStorage.getItem('albert.knowledge')));
  assert.ok(trained.every(item=>item.category==='SOP'&&item.sourceCount===1&&item.version===1&&item.approvedAt&&item.reusableStandards.length),`${viewport.name}: approved local knowledge records are structured`);
  assert.equal(await page.locator('.queue-row').count(),0,`${viewport.name}: raw queued sources are removed after success`);
  assert.deepEqual(browserErrors,[],`${viewport.name}: no browser console errors`);
  await context.close();
}
await browser.close();
console.log('Albert mobile and desktop UI smoke checks passed');
