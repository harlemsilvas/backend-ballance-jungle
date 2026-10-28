import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createFinancialHttpApp } from '../../src/interfaces/http/financial-http';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { assertRuntimeDatabase } from '../../src/infrastructure/persistence/runtime-database-check';

interface Reply { type(value:string): Reply; send(body:unknown): void; sendFile(path:string): void }
async function main(){
  if(process.env.NODE_ENV==='production'||process.env.AUTH_MODE!=='local-development'||process.env.FINANCIAL_API_ENABLED!=='true')throw new Error('LOCAL_SWAGGER_ONLY');
  const port=Number(process.env.PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_PORT');
  let orm:MikroORM|undefined,app:INestApplication|undefined;
  try{
    orm=await MikroORM.init(persistenceConfig());await assertRuntimeDatabase(orm);
    const owned=orm;app=await createFinancialHttpApp(orm,{onClose:()=>owned.close(true)});
    const adapter=app.getHttpAdapter();
    const spec=JSON.parse(readFileSync(resolve(__dirname,'openapi.json'),'utf8'));
    const html='<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ballance · Swagger local</title><link rel="stylesheet" href="/docs/swagger-ui.css"><body><p style="padding:12px;font-family:system-ui">Ambiente experimental local, sem autenticação real. POSTs criam dados. <a href="/openapi.json">OpenAPI JSON</a></p><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",deepLinking:true,displayRequestDuration:true,validatorUrl:null,supportedSubmitMethods:["get","post"]});</script></body></html>';
    adapter.get('/docs',(_req:unknown,res:Reply)=>res.type('html').send(html));
    adapter.get('/openapi.json',(_req:unknown,res:Reply)=>res.type('application/json').send(spec));
    for(const filename of ['swagger-ui.css','swagger-ui-bundle.js']){
      adapter.get('/docs/'+filename,(_req:unknown,res:Reply)=>res.sendFile(resolve(__dirname,'node_modules/swagger-ui-dist',filename)));
    }
    app.enableShutdownHooks();await app.listen(port,process.env.HTTP_HOST??'127.0.0.1');
    console.log(JSON.stringify({event:'LocalSwaggerStarted',port,docs:'/docs'}));
  }catch(error){if(app)await app.close();else if(orm)await orm.close(true);throw error;}
}
void main().catch(()=>{console.error(JSON.stringify({code:'LOCAL_SWAGGER_STARTUP_FAILED'}));process.exitCode=1;});
