import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { distribution } from './shared';

// Export completed observations; never overwrite an earlier report or infer an optimization.
async function main(){
  const input=resolve(process.argv[2]??'');const sequence=process.argv[3]??'';
  if(!process.argv[2]||!/^\d{3}$/.test(sequence)||Number(sequence)<2)throw new Error('REPORT_INPUT_AND_SEQUENCE_REQUIRED');
  const previous=Number(sequence)===2?'docs/LOAD_RESULTS.md':`docs/LOAD_RESULTS_${String(Number(sequence)-1).padStart(3,'0')}.md`;
  if(!await Bun.file(previous).exists())throw new Error('REPORT_PREVIOUS_REQUIRED');
  const markdown=`docs/LOAD_RESULTS_${sequence}.md`,artifact=`docs/benchmarks/results-${sequence}.json`;
  if(await Bun.file(markdown).exists()||await Bun.file(artifact).exists())throw new Error('REPORT_ALREADY_EXISTS');
  const environment=JSON.parse(await readFile(join(input,'environment.json'),'utf8'));
  for(const [path,hash] of Object.entries(environment.sourceHashes as Record<string,string>)){
    const actual=createHash('sha256').update(await readFile(path)).digest('hex');
    if(actual!==hash)throw new Error('REPORT_MEASURED_SOURCE_CHANGED');
  }
  const summaryFile=Bun.file(join(input,'summary.json'));
  let status='completed',results:Record<string,any>[]=[],populationLimits:unknown[]=[];
  const metricSum=(metrics:string[],name:string)=>metrics.reduce((total,text)=>total+text.split('\n').filter(line=>line.startsWith(name+'{')||line.startsWith(name+' ')).reduce((sum,line)=>sum+Number(line.split(' ').at(-1)),0),0);
  const flatten=(node:Record<string,any>):unknown[]=>[
    Object.fromEntries(['Node Type','Relation Name','Index Name','Actual Rows','Actual Loops','Rows Removed by Filter','Shared Hit Blocks','Shared Read Blocks'].filter(key=>key in node).map(key=>[key,node[key]])),
    ...(node.Plans??[]).flatMap((child:Record<string,any>)=>flatten(child)),
  ];
  const summarize=(r:Record<string,any>)=>{
      const {metrics,plans,attempts,...rest}=r;
      const probeSummary=Object.fromEntries(Object.entries(plans as Record<string,any[]>).map(([name,records])=>{
        const samples=records.map(row=>row['QUERY PLAN'][0]);
        return [name,{executionMs:distribution(samples.map(sample=>sample['Execution Time'])),planningMs:distribution(samples.map(sample=>sample['Planning Time'])),firstPlanNodes:flatten(samples[0].Plan)}];
      }));
      return {...rest,latencySamplesMs:attempts.map((a:{ms:number})=>a.ms),retryCount:metricSum(metrics,'wager_retries_total'),lockConflictCount:metricSum(metrics,'wager_lock_conflicts_total'),planProbes:probeSummary};
  };
  if(await summaryFile.exists()){
    const summary=await summaryFile.json();
    results=summary.results.map(summarize);
  }else{
    for await(const name of new Bun.Glob('*-population-limit.json').scan(input))populationLimits.push(JSON.parse(await readFile(join(input,name),'utf8')));
    if(!populationLimits.length)throw new Error('REPORT_NO_COMPLETED_OR_BOUNDED_RESULT');
    status='population-budget-exceeded';
    // Retain every earlier completed point if a later population hit the limit.
    for await(const name of new Bun.Glob('h*.json').scan(input)){
      if(name.endsWith('-population-limit.json'))continue;
      const r=JSON.parse(await readFile(join(input,name),'utf8'));
      results.push(summarize(r));
    }
  }
  results.sort((a,b)=>String(a.completedAt??'').localeCompare(String(b.completedAt??'')));
  const grouped=new Map<string,Record<string,any>[]>();
  for(const r of results){const key=[r.history,r.shape,r.transport,r.intervalMs].join('/');(grouped.get(key)??(grouped.set(key,[]),grouped.get(key)!)).push(r);}
  const groups=[...grouped].map(([key,cases])=>({key,repetitions:cases.length,
    history:cases[0]!.history,shape:cases[0]!.shape,transport:cases[0]!.transport,intervalMs:cases[0]!.intervalMs,
    processed:cases.reduce((sum,r)=>sum+r.processed,0),
    throughput:cases.reduce((sum,r)=>sum+r.processed,0)/(cases.reduce((sum,r)=>sum+r.elapsedMs,0)/1000),
    throughputRange:[Math.min(...cases.map(r=>r.throughput)),Math.max(...cases.map(r=>r.throughput))],
    latencyMs:distribution(cases.flatMap(r=>r.latencySamplesMs)),
  }));
  const record={sequence,status,createdAt:new Date().toISOString(),rawArtifacts:input,environment,results,populationLimits,groups};
  const f=(value:number|null|undefined)=>value==null?'-':value.toFixed(2);
  let text=`# Experimento ${sequence} — resultados\n\nEstado: **${status}**. [Registro estruturado](benchmarks/results-${sequence}.json). [Método](LOAD_TESTS.md). Brutos locais: \`${input}\`. Relatório anterior: [${Number(sequence)===2?'piloto 001':Number(sequence)-1}](${previous.replace('docs/','')}).\n\n`;
  text+=`Históricos: ${environment.histories.join(', ')}; wallets no perfil spread, quando selecionado: ${environment.walletCount}; distribuições: ${environment.shapes.join(', ')}; entradas: ${environment.transports.join(', ')}; comandos/caso: ${environment.requests}; processos: ${environment.processes}; concorrência: ${environment.concurrency}; repetições: ${environment.repeats}; intervalos de coleta: ${environment.scrapeIntervals.join(', ')}ms, além de off. Limite de população/caso: ${environment.seedBudgetMs||'não definido'}ms. Sondas SQL/caso: ${environment.probeRepeats} repetições por consulta.\n\n`;
  if(environment.repeats===1)text+='Este perfil executou uma repetição; não é a matriz contrabalanceada do experimento 002. ';
  text+='Quando há segunda repetição, ela percorre a matriz inteira em ordem inversa. Cada ponto tem população nova e constraints ativas. O número de wallets altera também o total de dados; não é um controle isolado de contenção. Código financeiro e dependências não foram otimizados entre esses pontos. Hardware, versões, configuração, hashes e indicadores por caso estão no JSON.\n\n';
  text+='## Casos executados, na ordem registrada\n\n| Caso | Seed (s) | ops/s | p50 (ms) | p95 (ms) | p99 (ms) | Lock p95 (ms) | Scrape p95 (ms) |\n|---|---|---|---|---|---|---|---|\n';
  for(const r of results)text+=`| ${r.label} | ${f(r.seedMs/1000)} | ${f(r.throughput)} | ${f(r.latencyMs.p50)} | ${f(r.latencyMs.p95)} | ${f(r.latencyMs.p99)} | ${f(r.lockWaitMs?.p95)} | ${f(r.scrapeMs?.p95)} |\n`;
  text+='\n## Agregação das repetições\n\nPercentis recalculados sobre as amostras reunidas; não é média de percentis. Throughput agregado pondera duração das janelas. Intervalos mínimo/máximo por repetição constam no JSON; essa agregação não prova causalidade nem saturação.\n\n| Histórico/distribuição/entrada/coleta(ms) | Repetições concluídas | ops/s | p50 | p95 | p99 |\n|---|---|---|---|---|---|\n';
  for(const g of groups)text+=`| ${g.key} | ${g.repetitions} | ${f(g.throughput)} | ${f(g.latencyMs.p50)} | ${f(g.latencyMs.p95)} | ${f(g.latencyMs.p99)} |\n`;
  if(populationLimits.length)text+='\n## Limite operacional de população\n\nA população foi interrompida após commits completos ao atingir o orçamento configurado. Não há janela medida para o ponto interrompido. Entradas alcançadas, custo observado e auditoria do histórico parcial estão no JSON. Não interpretar a ausência de amostras como throughput zero nem como falha financeira. Pontos anteriores concluídos não completam por si só a matriz solicitada.\n';
  text+='\n## Conferência e limites\n\nCada caso concluído registra auditoria de saldo/ledger/versão, replay, inbox/outbox e DLQ. Erros, retries e conflitos, quando disponíveis, estão separados no JSON. /metrics é medido pelo endpoint real, incluindo DB e SQS; probes SELECT não representam todo o custo de PL/pgSQL/commit. HTTP e SQS medem percursos distintos. A frequência efetiva e quantidade de scrapes precisam ser consideradas, sobretudo quando a janela é menor que o intervalo.\n\nEste arquivo preserva observações. O plano de melhoria será elaborado após encerrar os testes e revisar correção, variabilidade, planos SQL e limites operacionais; nenhuma melhoria é implementada automaticamente por este relatório.\n';
  await mkdir('docs/benchmarks',{recursive:true});
  await writeFile(artifact,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  await writeFile(markdown,text,{flag:'wx'});
  console.log(JSON.stringify({event:'load_report_saved',sequence,status,markdown,artifact}));
}
void main().catch((error:unknown)=>{console.error(error instanceof Error&&/^REPORT_[A-Z_]+$/.test(error.message)?error.message:'REPORT_FAILED');process.exitCode=1;});
