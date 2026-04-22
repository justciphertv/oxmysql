// ghmattimysql alias map. `execute` historically meant "general query" in
// ghmattimysql, so `query -> execute` is intentional and kept. The added
// entries (insert, update, single) were present in the upstream
// ghmattimysql export surface for years and are still referenced by older
// / converted resources.
export default {
  query: 'execute',
  insert: 'insert',
  update: 'update',
  single: 'single',
  scalar: 'scalar',
  transaction: 'transaction',
  store: 'store',
};
