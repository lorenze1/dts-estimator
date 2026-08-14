const ALLOWED_ACTIONS=new Set(['intake','proposal','knowledge']);
const MAX_BODY=5_500_000;

exports.handler=async event=>{
  if(event.httpMethod!=='POST')return reply(405,{error:'Method not allowed'});
  if(!process.env.ANTHROPIC_API_KEY)return reply(503,{error:'AI service is not configured'});
  if((event.body||'').length>MAX_BODY)return reply(413,{error:'File is too large. Use a PDF, text, or image file under 4 MB.'});
  try{
    const input=JSON.parse(event.body||'{}');
    if(!ALLOWED_ACTIONS.has(input.action))return reply(400,{error:'Invalid action'});
    const content=buildContent(input);
    if(content.error)return reply(400,{error:content.error});
    const response=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      signal:AbortSignal.timeout(24000),
      body:JSON.stringify({
        model:process.env.ANTHROPIC_MODEL||'claude-sonnet-4-6',
        max_tokens:input.action==='knowledge'?700:input.action==='proposal'?800:700,
        system:input.action==='knowledge'
          ?'You are ALBERT, an HVAC proposal standards analyst. Extract only standards explicitly supported by the approved source. Never invent pricing, warranty, legal, equipment, or code facts.'
          :'You are ALBERT, an HVAC field-intake and proposal assistant. Be concise and technical. Do not invent model, serial, price, warranty, code, or legal facts.',
        messages:[{role:'user',content:content.value}]
      })
    });
    if(!response.ok){console.error('Anthropic request failed',response.status);return reply(502,{error:'Albert could not reach Claude. Try again.'})}
    const data=await response.json();
    const text=data.content?.find(item=>item.type==='text')?.text||'';
    if(input.action==='proposal')return reply(200,{proposal:text});
    const parsed=parseJSON(text);
    if(input.action==='intake'){
      const intake=parsed||{summary:text,missingQuestions:[]};
      intake.missingQuestions=Array.isArray(intake.missingQuestions)?intake.missingQuestions.slice(0,6):[];
      return reply(200,intake);
    }
    return reply(200,{knowledge:parsed||{summary:text,standards:[]}});
  }catch(error){if(error.name==='TimeoutError')return reply(504,{error:'Claude took too long. Try again.'});console.error('Generate function failed',error.name);return reply(400,{error:'Invalid request'})}
};

function buildContent(input){
  if(input.action==='intake')return{value:`Turn these HVAC field notes into concise structured intake. Return valid JSON only with keys projectType, summary, extractedFields, missingQuestions. Keep summary under 80 words, include only fields supported by the notes, and ask at most 6 essential missing questions. Never guess equipment identifiers. Customer: ${clean(input.customer,200)}\nNotes: ${clean(input.description,6000)}`};
  if(input.action==='proposal')return{value:`Write a concise, action-first, field-sequenced HVAC proposal. Flag assumptions. Data: ${clean(JSON.stringify(input),10000)}`};
  const file=input.file||{};
  if(!file.base64||!file.type)return{error:'No readable file was received'};
  const category=clean(input.category||'Other',60);
  const instruction=`Analyze this approved company material classified as ${category}. Return JSON only with keys summary, standards, warrantyTerms, exclusions. standards, warrantyTerms, and exclusions must be arrays of concise strings. Extract reusable company standards appropriate to that category. Do not infer anything not stated in the source and do not retain filenames, customer details, addresses, dates, prices, or equipment identifiers.`;
  if(file.type==='application/pdf')return{value:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:file.base64}},{type:'text',text:instruction}]};
  if(file.type==='text/plain'){
    const text=Buffer.from(file.base64,'base64').toString('utf8').slice(0,100000);
    return{value:`${instruction}\n\nApproved source: ${clean(text,100000)}`};
  }
  if(['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))return{value:[{type:'image',source:{type:'base64',media_type:file.type,data:file.base64}},{type:'text',text:`${instruction} Read all legible proposal text in the image. Treat this as an approved example, but do not copy customer names, addresses, dates, prices, equipment identifiers, or other job-specific facts into reusable standards.`}]};
  return{error:'Use a PDF, plain text, or image file. Convert Word documents to PDF first.'};
}
function parseJSON(value){try{return JSON.parse(value.replace(/```json|```/g,'').trim())}catch{return null}}
function clean(value,length){return String(value||'').replace(/[<>]/g,'').slice(0,length)}
function reply(statusCode,body){return{statusCode,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'},body:JSON.stringify(body)}}
