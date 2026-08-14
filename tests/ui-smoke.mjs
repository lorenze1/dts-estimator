import assert from 'node:assert/strict';
import {chromium} from '/Users/lorenzelanier/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
for(const viewport of [{name:'mobile',width:390,height:844},{name:'desktop',width:1280,height:900}]){
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  page.setDefaultTimeout(7000);
  await page.route('**/.netlify/functions/generate',async route=>{
    const request=route.request(),body=JSON.parse(request.postData()||'{}');
    if(body.action==='intake')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({projectType:'RTU Replacement',summary:'Replace rooftop unit',extractedFields:{equipment:'RTU'},missingQuestions:['What is the electrical service?']})});
    if(body.action==='proposal')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({proposal:'Scope of Work\nReplace rooftop unit.\nAssumption: verify electrical service.'})});
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
  await context.close();
}
await browser.close();
console.log('Albert mobile and desktop UI smoke checks passed');
