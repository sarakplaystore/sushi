// sql.js ships a single-file build with the SQLite WASM binary inlined as base64.
// It needs no separately hosted `.wasm` asset, so it bundles cleanly into the
// lazily loaded Termix SQLite importer chunk on both Vercel and self-hosted setups.
declare module "sql.js/dist/sql-wasm-inline.js" {
  import initSqlJs from "sql.js";
  export default initSqlJs;
}
