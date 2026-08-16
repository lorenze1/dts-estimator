exports.handler=async()=>({
  statusCode:200,
  headers:{'content-type':'application/json','cache-control':'no-store'},
  body:JSON.stringify({configured:Boolean(process.env.MICROSOFT_CLIENT_ID),clientId:process.env.MICROSOFT_CLIENT_ID||'',tenant:process.env.MICROSOFT_TENANT_ID||'organizations'})
});
