import { load3000Environment, volumeEnvironment } from './profiles';
async function main(){
  const args=process.argv.slice(2);
  if(args.some(arg=>!['--describe','--volume'].includes(arg)))throw new Error('LOAD3000_UNKNOWN_ARGUMENT');
  const volume=args.includes('--volume');
  const config=volume?volumeEnvironment(process.env):load3000Environment(process.env);
  if(args.includes('--describe')){
    const keys=['LOAD_HISTORIES','LOAD_REQUESTS','LOAD_SHAPES','LOAD_TRANSPORTS','LOAD_REPEATS','LOAD_PROCESSES',
      'LOAD_CONCURRENCY','LOAD_SCRAPE_INTERVALS','LOAD_SQL_PROBE_REPEATS','LOAD_SEED_BUDGET_MS'];
    console.log(JSON.stringify({profile:volume?'history-volume-comparison':'history-3000',executesLoad:false,configuration:Object.fromEntries(keys.map(key=>[key,config[key]]))},null,2));return;
  }
  for(const [key,value] of Object.entries(config))if(value!==undefined)process.env[key]=value;
  await import('./run');
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'LOAD3000_CONFIGURATION_FAILED');process.exitCode=1;});
