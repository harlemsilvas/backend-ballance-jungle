/** Provision an existing non-owner runtime role; this never creates a global role. */
export function runtimeGrantSql(schema: string, role: string, includeReferenceJobs = true): string[] {
  for (const name of [schema, role]) if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('INVALID_SQL_IDENTIFIER');
  const s = `"${schema}"`; const r = `"${role}"`;
  return [
    `grant usage on schema ${s} to ${r}`,
    ...['wallets','wager_transactions','inbox_messages','outbox_messages'].map(table =>
      `grant select, insert, update on ${s}.${table} to ${r}`),
    `grant select, insert on ${s}.wallet_ledger to ${r}`,
    ...(includeReferenceJobs ? [`grant select, insert, update on ${s}.reference_jobs to ${r}`] : []),
    `grant execute on all functions in schema ${s} to ${r}`,
  ];
}
