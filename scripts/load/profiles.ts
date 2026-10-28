/** Named experiment; this is history per wallet, not users or simultaneous requests. */
export function load3000Environment(env: Readonly<Record<string,string|undefined>>): Record<string,string|undefined> {
  if (env.LOAD_HISTORIES !== undefined && env.LOAD_HISTORIES !== '3000') throw new Error('LOAD3000_HISTORY_CONFLICT');
  const budget=env.LOAD_SEED_BUDGET_MS??'180000';
  if (!/^\d+$/.test(budget)||Number(budget)<1000||Number(budget)>3600000) throw new Error('LOAD3000_BOUNDED_SEED_REQUIRED');
  return {...env,LOAD_HISTORIES:'3000',LOAD_REQUESTS:env.LOAD_REQUESTS??'120',LOAD_SHAPES:env.LOAD_SHAPES??'hot',
    LOAD_TRANSPORTS:env.LOAD_TRANSPORTS??'http',LOAD_REPEATS:env.LOAD_REPEATS??'1',LOAD_PROCESSES:env.LOAD_PROCESSES??'3',
    LOAD_CONCURRENCY:env.LOAD_CONCURRENCY??'6',LOAD_SCRAPE_INTERVALS:env.LOAD_SCRAPE_INTERVALS??'5000',
    LOAD_SQL_PROBE_REPEATS:env.LOAD_SQL_PROBE_REPEATS??'2',LOAD_SEED_BUDGET_MS:budget};
}

/** Comparable histories under one protocol; two repetitions reverse the full matrix. */
export function volumeEnvironment(env: Readonly<Record<string,string|undefined>>): Record<string,string|undefined> {
  if(env.LOAD_HISTORIES!==undefined&&env.LOAD_HISTORIES!=='100,1000,3000')throw new Error('LOAD_VOLUME_HISTORY_CONFLICT');
  const settings=load3000Environment({...env,LOAD_HISTORIES:'3000',LOAD_REPEATS:env.LOAD_REPEATS??'2'});
  return {...settings,LOAD_HISTORIES:'100,1000,3000'};
}
