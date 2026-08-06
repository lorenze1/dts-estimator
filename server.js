const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SYSTEM_PROMPTS = {
  default: `You are Brian Spatz, senior estimator at Diversified Thermal Services. Write like you know this job cold — because you do. Every line earns its place. If it repeats something, cut it. Scope bullets: action verb, technical fact, done. No filler. Clarifications: new information only — never restate the scope. Sequence: how a tech actually works the job, start to finish. Before you output — read it back. Cut anything repeated or redundant. Then send it.`,
  tsa_agreement: `You are Cliff Bailey, senior account executive at Diversified Thermal Services. Write Technical Support Agreements — annual service contracts for commercial building controls, DDC, and card access. Two-sentence introduction max. Support Location is the address only. Support Terms is one sentence. Never explain what preventive maintenance is to a facilities manager. Never use "culminating with" or "it is our intent through this document." Pricing: state the number clearly, billing terms, done. Special Conditions: bullet list only. Before outputting — read it back. Cut anything that repeats. Then send it.`,
  small_proposal: `You are Brian Spatz at Diversified Thermal Services. Write a tight one-page commercial controls or HVAC proposal. Scope bullets: verb + what + where. Specific equipment and quantities. Startup and commissioning = one bullet. Cleanup = one bullet. Clarifications: 3-5 lines max. Never restate scope. Keep it under one page. Before outputting — cut anything repeated. Then send it.`
};

async function getCached(query) {
  try {
    const { data } = await supabase.from('search_cache')
      .select('results').eq('query', query)
      .gt('expires_at', new Date().toISOString()).single();
    return data?.results || null;
  } catch(e) { return null; }
}

async function setCache(query, results) {
  const expires = new Date(Date.now() + 86400000).toISOString();
  await supabase.from('search_cache')
    .upsert({ query, results, cached_at: new Date().toISOString(), expires_at: expires });
}

async function googleSearch(query) {
  const cached = await getCached(query);
  if (cached) return { results: cached, cached: true };
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&num=5`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
  const data = await resp.json();
  const results = (data.items || []).map(i => ({ title: i.title, snippet: i.snippet, link: i.link }));
  await setCache(query, results);
  return { results, cached: false };
}

async function searchEquipment(mfg, model) {
  if (!mfg || !model) return null;
  const yr = new Date().getFullYear();
  const [specs, prices, status] = await Promise.allSettled([
    googleSearch(`${mfg} ${model} specifications installation requirements ${yr}`),
    googleSearch(`${mfg} ${model} HVAC wholesale price distributor ${yr}`),
    googleSearch(`${mfg} ${model} discontinued replacement superseded ${yr}`)
  ]);
  const specR  = specs.status  === 'fulfilled' ? specs.value.results  : [];
  const priceR = prices.status === 'fulfilled' ? prices.value.results : [];
  const statR  = status.status === 'fulfilled' ? status.value.results : [];
  const priceText = priceR.map(r => r.snippet + ' ' + r.title).join(' ');
  const prices$ = (priceText.match(/\$[\d,]+(?:\\.\d{2})?/g) || [])
    .map(p => parseFloat(p.replace(/[$,]/g,'')))
    .filter(p => p > 200 && p < 50000);
  const statusText = statR.map(r => r.snippet + ' ' + r.title).join(' ').toLowerCase();
  const discontinued = statusText.includes('discontinued') || statusText.includes('no longer available') || statusText.includes('end of life') || statusText.includes('replaced by') || statusText.includes('successor');
  const replMatch = discontinued ? (statusText.match(/replaced by\s+([\w-]+)/i) || statusText.match(/successor[:\s]+([\w-]+)/i)) : null;
  return {
    mfg, model,
    specs_found: specR.length > 0,
    price_range: prices$.length >= 2 ? { low: Math.min(...prices$), high: Math.max(...prices$), avg: Math.round(prices$.reduce((a,b)=>a+b,0)/prices$.length) } : null,
    discontinued,
    replacement_model: replMatch ? replMatch[1].toUpperCase() : null,
    raw_specs: specR.slice(0,2),
    raw_prices: priceR.slice(0,2)
  };
}

async function searchLaborRates(city, state) {
  if (!city || !state) return null;
  const yr = new Date().getFullYear();
  const [prev, union] = await Promise.allSettled([
    googleSearch(`commercial HVAC journeyman prevailing wage ${city} ${state} ${yr}`),
    googleSearch(`HVAC union Local journeyman wage rate ${state} ${yr}`)
  ]);
  const allText = [...(prev.status==='fulfilled'?prev.value.results:[]),...(union.status==='fulfilled'?union.value.results:[])].map(r=>r.snippet+' '+r.title).join(' ');
  const rateMatches = allText.match(/\$(\d{2,3})(?:\\.\d{2})?\s*(?:per hour|\/hr|\/hour)/gi) || [];
  const rates = rateMatches.map(r=>parseFloat(r.replace(/[$\/hour per hr]/gi,'').trim())).filter(r=>r>=50&&r<=350);
  return { market_rate_found: rates.length>0, avg_market_rate: rates.length>0?Math.round(rates.reduce((a,b)=>a+b,0)/rates.length):null, prevailing_wage_applicable: allText.toLowerCase().includes('prevailing wage') };
}

async function buildToneContext(templateId) {
  const parts = [];
  const { data: examples } = await supabase.from('proposals').select('client_name, final_scope, sell_price, created_at').eq('template_id', templateId).eq('status','approved').not('final_scope','is',null).order('created_at',{ascending:false}).limit(5);
  if (examples?.length>0) parts.push('APPROVED DTS EXAMPLES — study this voice:\n\n'+examples.map((e,i)=>`EXAMPLE ${i+1} — ${e.client_name}:\n${e.final_scope}`).join('\n\n---\n\n'));
  const { data: corrected } = await supabase.from('proposals').select('edit_delta').eq('template_id',templateId).eq('status','approved').not('edit_delta','is',null).order('created_at',{ascending:false}).limit(15);
  if (corrected?.length>0) {
    const corrections = corrected.flatMap(c=>c.edit_delta?.tagged_corrections||[]).filter(Boolean).slice(0,8);
    if (corrections.length>0) parts.push('DO NOT REPEAT THESE PATTERNS:\n'+corrections.map(c=>`• ${c}`).join('\n'));
  }
  return parts.join('\n\n---\n\n');
}

async function buildPricingContext(templateId, state, laborSearch) {
  const { data: history } = await supabase.from('pricing_history').select('sell_price, labor_rate_used').eq('template_id',templateId).order('created_at',{ascending:false}).limit(20);
  const { data: stateHist } = await supabase.from('pricing_history').select('sell_price').eq('template_id',templateId).eq('state',state).order('created_at',{ascending:false}).limit(10);
  const allPrices = (history||[]).map(h=>h.sell_price).filter(Boolean);
  const statePrices = (stateHist||[]).map(h=>h.sell_price).filter(Boolean);
  const laborRates = (history||[]).map(h=>h.labor_rate_used).filter(Boolean);
  const histRate = laborRates.length>0?Math.round(laborRates.reduce((a,b)=>a+b,0)/laborRates.length):null;
  const recommendedRate = laborSearch?.avg_market_rate||histRate||175;
  return { has_history:allPrices.length>0, global_avg:allPrices.length>0?Math.round(allPrices.reduce((a,b)=>a+b,0)/allPrices.length):null, state_avg:statePrices.length>0?Math.round(statePrices.reduce((a,b)=>a+b,0)/statePrices.length):null, sample_count:allPrices.length, recommended_rate:recommendedRate, recommended_ot_rate:Math.round(recommendedRate*1.4), rate_source:laborSearch?.avg_market_rate?'live_search':histRate?'job_history':'ca_default', prevailing_wage:laborSearch?.prevailing_wage_applicable||false };
}

async function checkEquipmentFlag(mfg, model, equipSearch) {
  if (!equipSearch?.discontinued) return null;
  const { data: existing } = await supabase.from('equipment_flags').select('message').eq('manufacturer',mfg).eq('model',model).eq('active',true).single();
  if (existing) return existing.message;
  const msg = equipSearch.replacement_model ? `${mfg} ${model} appears discontinued — current equivalent may be ${equipSearch.replacement_model}. Verify with distributor before quoting.` : `${mfg} ${model} status uncertain — confirm availability with distributor before quoting.`;
  await supabase.from('equipment_flags').insert({ manufacturer:mfg, model, flag_type:equipSearch.replacement_model?'superseded':'discontinued', message:msg, active:true, created_at:new Date().toISOString() });
  return msg;
}

function buildPricingSuggestion(templateId, answers, pricingCtx, equipSearch) {
  const defaults = { boiler:{labor_hrs:16,crew:2}, mini_split:{labor_hrs:8,crew:2}, rtu:{labor_hrs:20,crew:2}, compressor:{labor_hrs:10,crew:2}, pump:{labor_hrs:8,crew:2}, chiller:{labor_hrs:24,crew:2}, cooling_tower:{labor_hrs:24,crew:2}, leak:{labor_hrs:4,crew:1}, condenser:{labor_hrs:12,crew:2}, hot_water_tank:{labor_hrs:8,crew:2}, pm_findings:{labor_hrs:4,crew:1}, small_proposal:{labor_hrs:6,crew:1}, tsa_agreement:{labor_hrs:0,crew:0} };
  if (templateId==='tsa_agreement') { const annual=parseFloat(answers.annual_price||'0'); return {suggested_sell:annual,confidence:'entered',note:'Annual agreement price as entered'}; }
  const d = defaults[templateId]||defaults.boiler;
  const isOT = (answers.schedule||'').toLowerCase().includes('after')||(answers.schedule||'').toLowerCase().includes('weekend');
  const rate = isOT?pricingCtx.recommended_ot_rate:pricingCtx.recommended_rate;
  const labor = Math.round(rate*d.crew*(d.labor_hrs+1.5));
  let equipCost = equipSearch?.price_range?.avg||2500;
  const equipWithMarkup = Math.round(equipCost*1.30);
  const critSurcharge = (answers.critical==='yes'||(answers.equip_loc||'').toLowerCase().includes('server'))?1000:0;
  const suggested = labor+equipWithMarkup+critSurcharge;
  const confidence = pricingCtx.state_sample_count>=5?'high':pricingCtx.sample_count>=3?'medium':'low';
  const notes = [];
  if (pricingCtx.state_avg) notes.push(`${pricingCtx.sample_count} similar jobs averaged $${pricingCtx.state_avg.toLocaleString()}`);
  if (equipSearch?.price_range) notes.push(`Equipment: $${equipSearch.price_range.low.toLocaleString()}–$${equipSearch.price_range.high.toLocaleString()}`);
  if (pricingCtx.prevailing_wage) notes.push('⚠️ Prevailing wage may apply — verify before finalizing');
  if (critSurcharge) notes.push(`+$${critSurcharge.toLocaleString()} critical cooling surcharge`);
  return { suggested_sell:suggested, labor_estimate:labor, equipment_estimate:equipWithMarkup, critical_surcharge:critSurcharge, labor_rate_used:rate, after_hours:isOT, confidence, notes, range:{low:Math.round(suggested*0.92),high:Math.round(suggested*1.10)} };
}

app.post('/api/generate', async (req, res) => {
  const { template_id='boiler', answers={}, photos=[] } = req.body;
  const startTime = Date.now();
  let proposalId;
  try {
    const { data: draft } = await supabase.from('proposals').insert({ template_id, client_name:answers.client||'Unknown', address:answers.address||'', state:extractState(answers.address||''), answers, status:'draft', created_at:new Date().toISOString() }).select('id').single();
    if (draft) proposalId = draft.id;
    const city = extractCity(answers.address||'');
    const state = extractState(answers.address||'');
    const needsEquipSearch = !['tsa_agreement','small_proposal','pm_findings'].includes(template_id);
    const [equipResult, laborResult] = await Promise.allSettled([
      needsEquipSearch?searchEquipment(answers.mfg,answers.model):Promise.resolve(null),
      searchLaborRates(city,state)
    ]);
    const equipSearch = equipResult.status==='fulfilled'?equipResult.value:null;
    const laborSearch = laborResult.status==='fulfilled'?laborResult.value:null;
    const equipFlag = needsEquipSearch?await checkEquipmentFlag(answers.mfg,answers.model,equipSearch):null;
    const [toneCtx, pricingCtx] = await Promise.allSettled([buildToneContext(template_id),buildPricingContext(template_id,state,laborSearch)]);
    const tone = toneCtx.status==='fulfilled'?toneCtx.value:'';
    const pricing = pricingCtx.status==='fulfilled'?pricingCtx.value:{recommended_rate:175,recommended_ot_rate:245,rate_source:'ca_default',prevailing_wage:false};
    let photoContext = '';
    if (photos.length>0) {
      try {
        const pr = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,system:'Commercial HVAC field tech assistant for DTS. Extract technical data from job site photos. Return only valid JSON: {"extracted_fields":{},"observations":[],"flags":[]}',messages:[{role:'user',content:[...photos.slice(0,4).map(p=>({type:'image',source:{type:'base64',media_type:p.type||'image/jpeg',data:p.base64}})),{type:'text',text:'Identify equipment specs, pipe size/material, valve condition, and any scope risks. JSON only.'}]}]})});
        const pd = await pr.json();
        const pt = pd.content?.find(b=>b.type==='text')?.text||'{}';
        const parsed = JSON.parse(pt.replace(/```json|```/g,'').trim());
        if (parsed.extracted_fields) Object.assign(answers,parsed.extracted_fields);
        if (parsed.observations?.length) photoContext='PHOTO OBSERVATIONS:\n'+parsed.observations.join('\n');
        if (parsed.flags?.length) photoContext+='\nPHOTO FLAGS:\n'+parsed.flags.map(f=>`⚠️ ${f}`).join('\n');
      } catch(e) {}
    }
    const basePrompt = SYSTEM_PROMPTS[template_id]||SYSTEM_PROMPTS.default;
    const systemParts = [basePrompt];
    if (tone) systemParts.push(tone);
    if (pricing.recommended_rate!==175) systemParts.push(`LABOR CONTEXT: Market rate for ${city||state} is ~$${pricing.recommended_rate}/hr standard, $${pricing.recommended_ot_rate}/hr after-hours.`);
    const systemPrompt = systemParts.join('\n\n---\n\n');
    let searchContext = '';
    if (equipSearch?.specs_found) {
      searchContext += `\nEQUIPMENT DATA (${answers.mfg} ${answers.model}):`;
      if (equipSearch.price_range) searchContext+=`\n• Wholesale: $${equipSearch.price_range.low.toLocaleString()}–$${equipSearch.price_range.high.toLocaleString()}`;
      if (equipSearch.raw_specs[0]) searchContext+=`\n• Spec: ${equipSearch.raw_specs[0].snippet}`;
    }
    if (laborSearch?.market_rate_found) {
      searchContext+=`\nLABOR (${city} ${state}): $${laborSearch.avg_market_rate}/hr market rate`;
      if (laborSearch.prevailing_wage_applicable) searchContext+=' ⚠️ Prevailing wage may apply';
    }
    const answersSummary = Object.entries(answers).filter(([,v])=>v&&v!==''&&v!=='None').map(([k,v])=>`${k.replace(/_/g,' ')}: ${v}`).join('\n');
    const userMessage = `Write a complete DTS ${template_id.replace(/_/g,' ')} for this job.

CLIENT: ${answers.client||'[Client]'}
ADDRESS: ${answers.address||'[Address]'}
PROJECT: ${answers.project||answers.system_detail||'[Project]'}

INTAKE ANSWERS:
${answersSummary}
${searchContext}
${photoContext}

No preamble. Output the document directly.`;
    const aiResp = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2500,system:systemPrompt,messages:[{role:'user',content:userMessage}]})});
    const aiData = await aiResp.json();
    const scope = aiData.content?.find(b=>b.type==='text')?.text||'';
    const pricingSuggestion = buildPricingSuggestion(template_id,answers,pricing,equipSearch);
    const flags = [];
    if (equipFlag) flags.push({type:'equipment',message:equipFlag,severity:'warning'});
    if (pricing.prevailing_wage) flags.push({type:'labor',message:`Prevailing wage may apply in ${city} ${state}`,severity:'info'});
    if (answers.mfg&&answers.model) {
      const { data: storedFlags } = await supabase.from('equipment_flags').select('message,flag_type').eq('manufacturer',answers.mfg).eq('active',true);
      storedFlags?.forEach(f=>{if(!flags.find(x=>x.message===f.message))flags.push({type:f.flag_type,message:f.message,severity:'warning'});});
    }
    if (proposalId) await supabase.from('proposals').update({ai_scope_draft:scope,search_data:{equipment:equipSearch,labor:laborSearch},pricing_suggestion:pricingSuggestion}).eq('id',proposalId);
    return res.json({ proposal_id:proposalId, scope, pricing:pricingSuggestion, flags, search_summary:{equipment_found:equipSearch?.specs_found||false,labor_rate_found:laborSearch?.market_rate_found||false,labor_rate:pricing.recommended_rate,rate_source:pricing.rate_source}, meta:{generation_ms:Date.now()-startTime,training_examples:tone?(tone.match(/EXAMPLE \d/g)||[]).length:0} });
  } catch(err) {
    console.error('Generate error:',err);
    return res.status(500).json({error:err.message,proposal_id:proposalId});
  }
});

app.post('/api/approve', async (req, res) => {
  const { proposal_id, final_scope, sell_price, estimator_id, notes } = req.body;
  if (!proposal_id||!final_scope) return res.status(400).json({error:'proposal_id and final_scope required'});
  try {
    const { data: proposal } = await supabase.from('proposals').select('*').eq('id',proposal_id).single();
    if (!proposal) return res.status(404).json({error:'proposal not found'});
    const editDelta = calculateEditDelta(proposal.ai_scope_draft||'',final_scope);
    await supabase.from('proposals').update({final_scope,sell_price:sell_price||null,status:'approved',estimator_id:estimator_id||null,edit_delta:editDelta,approved_at:new Date().toISOString()}).eq('id',proposal_id);
    if (sell_price) {
      await supabase.from('pricing_history').insert({template_id:proposal.template_id,state:extractState(proposal.address||''),city:extractCity(proposal.address||''),sell_price,labor_rate_used:proposal.pricing_suggestion?.labor_rate_used||175,scope_conditions:{after_hours:proposal.answers?.schedule?.includes('After')||false,critical_cooling:proposal.answers?.critical==='yes'},created_at:new Date().toISOString()});
    }
    await supabase.from('scope_library').insert({template_id:proposal.template_id,scope_text:final_scope,source:'approved_proposal',quality_score:editDelta.significant_edits>3?6:9,client_name:proposal.client_name,created_at:new Date().toISOString()});
    return res.json({success:true,proposal_id,edit_summary:editDelta.summary,lines_changed:editDelta.lines_changed,significant_edits:editDelta.significant_edits,training_note:editDelta.significant_edits>5?'Heavy edits captured — corrections will improve future drafts':'Stored as training example'});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

function calculateEditDelta(original, edited) {
  const origLines=(original||'').split('\n');
  const editLines=(edited||'').split('\n');
  let linesChanged=0,significantEdits=0;
  const taggedCorrections=[];
  const maxLines=Math.max(origLines.length,editLines.length);
  for(let i=0;i<maxLines;i++){
    const orig=(origLines[i]||'').trim();
    const edit=(editLines[i]||'').trim();
    if(orig===edit)continue;
    linesChanged++;
    if(!orig&&edit){taggedCorrections.push(`BULLET_ADDED: "${edit.substring(0,80)}"`);significantEdits++;}
    else if(orig&&!edit){taggedCorrections.push(`BULLET_REMOVED: "${orig.substring(0,80)}"`);significantEdits++;}
    else if(orig.startsWith('•')||edit.startsWith('•')){taggedCorrections.push(`SCOPE_BULLET_CHANGED: "${orig.substring(0,60)}" → "${edit.substring(0,60)}"`);significantEdits++;}
    else if(/^\d+\./.test(orig)){taggedCorrections.push(`CLARIFICATION_CHANGED: "${orig.substring(0,60)}" → "${edit.substring(0,60)}"`);}
  }
  return {lines_changed:linesChanged,significant_edits:significantEdits,tagged_corrections:taggedCorrections.slice(0,10),summary:significantEdits===0?'Approved as-is':significantEdits<=3?`Light edits — ${significantEdits} changes`:`${significantEdits} changes — corrections captured for learning`};
}

app.post('/api/analyze-photos', async (req, res) => {
  const { photos=[], prompt='', step_id='' } = req.body;
  if (!photos.length) return res.status(400).json({error:'no photos'});
  try {
    const imageContent = photos.slice(0,4).map(p=>({type:'image',source:{type:'base64',media_type:p.type||'image/jpeg',data:p.base64}}));
    const resp = await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:600,system:'You are a commercial HVAC field tech assistant for Diversified Thermal Services. Extract technical data from job site photos to pre-fill an intake form. Be precise — only report what you clearly see. Return ONLY valid JSON, no preamble or markdown.',messages:[{role:'user',content:[...imageContent,{type:'text',text:prompt||'Extract equipment specs, pipe sizes, valve conditions, and any scope risks. Return JSON: {"extracted_fields":{},"observations":[],"flags":[]}'}]}]})});
    const data = await resp.json();
    const raw = data.content?.find(b=>b.type==='text')?.text||'{}';
    const result = JSON.parse(raw.replace(/```json|```/g,'').trim());
    return res.json({result,step_id});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [totals,approved,library,flags] = await Promise.allSettled([
      supabase.from('proposals').select('*',{count:'exact',head:true}),
      supabase.from('proposals').select('*',{count:'exact',head:true}).eq('status','approved'),
      supabase.from('scope_library').select('*',{count:'exact',head:true}),
      supabase.from('equipment_flags').select('*',{count:'exact',head:true}).eq('active',true)
    ]);
    const total=totals.status==='fulfilled'?totals.value.count:0;
    const approvedN=approved.status==='fulfilled'?approved.value.count:0;
    const libN=library.status==='fulfilled'?library.value.count:0;
    const flagN=flags.status==='fulfilled'?flags.value.count:0;
    return res.json({proposals_total:total,proposals_approved:approvedN,approval_rate:total>0?Math.round((approvedN/total)*100)+'%':'N/A',scope_library_size:libN,active_flags:flagN,learning_status:approvedN<5?'Building baseline':approvedN<20?'Learning — improving with each approval':'Trained — calibrated to DTS voice'});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

function extractCity(address) { const parts=address.split(','); return parts.length>=2?parts[parts.length-2].trim().replace(/\s+[A-Z]{2}\s*$/,'').trim():''; }
function extractState(address) { const m=address.match(/,?\s*([A-Z]{2})\s*\d{5}/); return m?m[1]:'CA'; }

app.get('/health',(req,res)=>res.json({status:'ok',version:'3.0',templates:['boiler','mini_split','rtu','compressor','chiller','pump','cooling_tower','leak','condenser','hot_water_tank','pm_findings','tsa_agreement','small_proposal']}));

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`DTS Estimator Backend v3 on port ${PORT}`));
module.exports = app;
