// Historical mysql-async export names. `single -> mysql_fetch` was shipped
// by the original mysql-async for a long time before `mysql_fetch_all` was
// introduced; consumers that still reference `mysql_fetch` for first-row
// access would otherwise get a 'No such export' error.
export default {
  update: 'mysql_execute',
  insert: 'mysql_insert',
  query: 'mysql_fetch_all',
  single: 'mysql_fetch',
  scalar: 'mysql_fetch_scalar',
  transaction: 'mysql_transaction',
  store: 'mysql_store',
};
