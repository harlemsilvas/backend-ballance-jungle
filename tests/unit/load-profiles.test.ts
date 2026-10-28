import { expect,test } from 'bun:test';
import { load3000Environment, volumeEnvironment } from '../../scripts/load/profiles';
test('3000 profile is explicit and bounded without silently changing the default runner',()=>{
  const input={LOAD_CONFIRM:'isolated',LOAD_REQUESTS:'48'};const result=load3000Environment(input);
  expect(result.LOAD_HISTORIES).toBe('3000');expect(result.LOAD_SEED_BUDGET_MS).toBe('180000');
  expect(result.LOAD_REQUESTS).toBe('48');expect(result.LOAD_REPEATS).toBe('1');
  expect(input).toEqual({LOAD_CONFIRM:'isolated',LOAD_REQUESTS:'48'});
});
test('3000 profile refuses conflicting history or unbounded population before running',()=>{
  expect(()=>load3000Environment({LOAD_HISTORIES:'1000'})).toThrow('LOAD3000_HISTORY_CONFLICT');
  expect(()=>load3000Environment({LOAD_SEED_BUDGET_MS:'0'})).toThrow('LOAD3000_BOUNDED_SEED_REQUIRED');
  expect(()=>load3000Environment({LOAD_SEED_BUDGET_MS:'not-a-number'})).toThrow();
});

test('volume comparison holds protocol constant and repeats all three histories',()=>{
  const config=volumeEnvironment({});expect(config.LOAD_HISTORIES).toBe('100,1000,3000');
  expect(config.LOAD_REPEATS).toBe('2');expect(config.LOAD_TRANSPORTS).toBe('http');expect(config.LOAD_SHAPES).toBe('hot');
  expect(()=>volumeEnvironment({LOAD_HISTORIES:'50'})).toThrow('LOAD_VOLUME_HISTORY_CONFLICT');
});
