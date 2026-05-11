/**
 * Minimal supabase-shaped query builder over node-postgres (pg).
 *
 * Why: routes/nport.js uses the Supabase chainable-builder pattern:
 *   client.from('table').select('*').eq('col', val).order(...).range(...)
 * We want to run those exact routes against a local Postgres for
 * integration tests (and the standalone dev server). This module
 * implements just enough of the surface to make the routes' calls work:
 *   .from(table)
 *   .select(cols, opts?)
 *   .eq(col, val) / .gte / .gt / .lte / .lt / .neq
 *   .in(col, arr)
 *   .is(col, val)                  -> for `IS NULL`
 *   .or('a.is.null,b.eq.x')        -> compiles into a SQL OR clause
 *   .order(col, { ascending, nullsFirst })
 *   .limit(n) / .range(a, b)
 *   .insert(row|rows) (.select() chainable)
 *   .update(patch) (.in(col, arr) optional)
 *   .maybeSingle() / .single()
 *   await builder  -> { data, error, count? }
 *
 * This is deliberately small. It is NOT a Supabase reimplementation —
 * just enough for the routes in this folder.
 */

const { Pool } = require('pg');

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function compileOrClause(orStr, paramStart) {
  // 'a.is.null,b.eq.x' -> "(\"a\" IS NULL OR \"b\" = $N)"
  // Returns { sql, params, next }
  const parts = orStr.split(',');
  const sqlClauses = [];
  const params = [];
  let next = paramStart;
  for (const part of parts) {
    const m = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-z]+)\.(.+)$/);
    if (!m) continue;
    const col = quoteIdent(m[1]);
    const op = m[2];
    const val = m[3];
    if (op === 'is' && (val === 'null' || val === 'NULL')) {
      sqlClauses.push(`${col} IS NULL`);
    } else if (op === 'eq') {
      sqlClauses.push(`${col} = $${next}`);
      params.push(val);
      next += 1;
    } else if (op === 'neq') {
      sqlClauses.push(`${col} <> $${next}`);
      params.push(val);
      next += 1;
    } else {
      // unsupported sub-op; skip silently rather than corrupt the query
      continue;
    }
  }
  return { sql: '(' + sqlClauses.join(' OR ') + ')', params, next };
}

function makePool(connStr) {
  return new Pool({ connectionString: connStr });
}

function makeClient(connStr) {
  const pool = makePool(connStr);

  function from(table) {
    // Per-builder mutable state.
    let mode = 'select'; // 'select' | 'insert' | 'update'
    let selectCols = '*';
    let wantCount = false;
    let where = []; // { sql, params }
    let orderClauses = [];
    let limitVal = null;
    let offsetVal = null;
    let rangeVal = null; // [start, end] inclusive
    let insertRows = null;
    let updatePatch = null;
    let selectAfterMutation = false;

    function addWhereWithParam(colSql, op, val, paramCount) {
      where.push({ sql: `${colSql} ${op} $${paramCount}`, val });
    }

    const builder = {
      select(cols, opts) {
        if (mode === 'select') {
          selectCols = cols || '*';
          if (opts && opts.count === 'exact') {
            wantCount = true;
          }
        } else {
          // After insert/update, .select() asks for the affected rows back.
          selectAfterMutation = true;
        }
        return builder;
      },
      eq(col, val) {
        if (mode === 'update' && updatePatch && !insertRows) {
          // For UPDATE we still treat this like a filter on the WHERE.
        }
        where.push({ kind: 'eq', col, val });
        return builder;
      },
      neq(col, val) {
        where.push({ kind: 'neq', col, val });
        return builder;
      },
      gt(col, val) {
        where.push({ kind: 'gt', col, val });
        return builder;
      },
      gte(col, val) {
        where.push({ kind: 'gte', col, val });
        return builder;
      },
      lt(col, val) {
        where.push({ kind: 'lt', col, val });
        return builder;
      },
      lte(col, val) {
        where.push({ kind: 'lte', col, val });
        return builder;
      },
      in(col, arr) {
        where.push({ kind: 'in', col, val: arr || [] });
        return builder;
      },
      is(col, val) {
        where.push({ kind: 'is', col, val });
        return builder;
      },
      or(orStr) {
        where.push({ kind: 'or', orStr });
        return builder;
      },
      order(col, opts) {
        const asc = opts && opts.ascending === false ? 'DESC' : 'ASC';
        // nullsFirst defaults to nulls last for DESC, nulls first for ASC in pg.
        let nulls = '';
        if (opts && opts.nullsFirst === true) nulls = ' NULLS FIRST';
        if (opts && opts.nullsFirst === false) nulls = ' NULLS LAST';
        orderClauses.push(`${quoteIdent(col)} ${asc}${nulls}`);
        return builder;
      },
      limit(n) {
        limitVal = parseInt(n, 10);
        return builder;
      },
      range(start, end) {
        rangeVal = [parseInt(start, 10), parseInt(end, 10)];
        return builder;
      },
      insert(rowOrRows) {
        mode = 'insert';
        insertRows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        return builder;
      },
      update(patch) {
        mode = 'update';
        updatePatch = patch;
        return builder;
      },
      _build() {
        // Build SQL + params from the current state.
        const params = [];
        const whereSqlParts = [];

        function pushParam(v) {
          params.push(v);
          return `$${params.length}`;
        }

        function compileWhere(w) {
          const ph = pushParam(w.val);
          const col = quoteIdent(w.col);
          if (w.kind === 'eq') return `${col} = ${ph}`;
          if (w.kind === 'neq') return `${col} <> ${ph}`;
          if (w.kind === 'gt') return `${col} > ${ph}`;
          if (w.kind === 'gte') return `${col} >= ${ph}`;
          if (w.kind === 'lt') return `${col} < ${ph}`;
          if (w.kind === 'lte') return `${col} <= ${ph}`;
          throw new Error(`unsupported where kind: ${w.kind}`);
        }

        for (const w of where) {
          if (w.kind === 'in') {
            const phs = [];
            for (const v of w.val) phs.push(pushParam(v));
            const col = quoteIdent(w.col);
            whereSqlParts.push(
              w.val.length === 0 ? 'FALSE' : `${col} IN (${phs.join(', ')})`
            );
          } else if (w.kind === 'is') {
            const col = quoteIdent(w.col);
            if (w.val === null) {
              whereSqlParts.push(`${col} IS NULL`);
            } else if (w.val === true) {
              whereSqlParts.push(`${col} IS TRUE`);
            } else if (w.val === false) {
              whereSqlParts.push(`${col} IS FALSE`);
            } else {
              const ph = pushParam(w.val);
              whereSqlParts.push(`${col} IS ${ph}`);
            }
          } else if (w.kind === 'or') {
            const out = compileOrClause(w.orStr, params.length + 1);
            // append params and bump our local counter
            for (const p of out.params) params.push(p);
            whereSqlParts.push(out.sql);
          } else {
            whereSqlParts.push(compileWhere(w));
          }
        }

        const whereSql =
          whereSqlParts.length > 0 ? ' WHERE ' + whereSqlParts.join(' AND ') : '';

        if (mode === 'select') {
          // selectCols may be 'col1,col2' or '*' — pass through verbatim
          // (we trust route-side construction). For count: use COUNT(*).
          let lim = '';
          let off = '';
          if (rangeVal) {
            // Supabase's range(start, end) is inclusive on both ends.
            const start = rangeVal[0];
            const end = rangeVal[1];
            const span = end - start + 1;
            lim = ` LIMIT ${span}`;
            off = ` OFFSET ${start}`;
          } else if (limitVal != null) {
            lim = ` LIMIT ${limitVal}`;
          }
          const ord =
            orderClauses.length > 0 ? ' ORDER BY ' + orderClauses.join(', ') : '';
          const sql = `SELECT ${selectCols} FROM ${quoteIdent(table)}${whereSql}${ord}${lim}${off}`;
          let countSql = null;
          if (wantCount) {
            countSql = `SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}${whereSql}`;
          }
          return { sql, params, countSql };
        }

        if (mode === 'insert') {
          if (!insertRows || insertRows.length === 0) {
            return { sql: 'SELECT 1 WHERE FALSE', params: [] };
          }
          const cols = Array.from(
            new Set(insertRows.flatMap((r) => Object.keys(r || {})))
          );
          const colsSql = cols.map(quoteIdent).join(', ');
          const valueRows = insertRows.map((r) => {
            const phs = cols.map((c) => pushParam(r[c] === undefined ? null : r[c]));
            return `(${phs.join(', ')})`;
          });
          const ret = selectAfterMutation ? ' RETURNING *' : '';
          return {
            sql: `INSERT INTO ${quoteIdent(table)} (${colsSql}) VALUES ${valueRows.join(', ')}${ret}`,
            params,
          };
        }

        if (mode === 'update') {
          const cols = Object.keys(updatePatch || {});
          const setSql = cols
            .map((c) => `${quoteIdent(c)} = ${pushParam(updatePatch[c])}`)
            .join(', ');
          const ret = selectAfterMutation ? ' RETURNING *' : '';
          return {
            sql: `UPDATE ${quoteIdent(table)} SET ${setSql}${whereSql}${ret}`,
            params,
          };
        }

        throw new Error(`unknown builder mode: ${mode}`);
      },

      // -- terminal methods that actually execute --------------------------
      async _exec(singleMode) {
        const built = builder._build();
        try {
          const rs = await pool.query(built.sql, built.params);
          let count;
          if (built.countSql) {
            const cs = await pool.query(built.countSql, built.params);
            count = (cs.rows[0] && cs.rows[0].c) || 0;
          }
          let data = rs.rows;
          if (singleMode) {
            data = data && data.length > 0 ? data[0] : null;
          }
          return { data, error: null, count };
        } catch (err) {
          return { data: null, error: err, count: undefined };
        }
      },
      then(onF, onR) {
        return builder._exec(false).then(onF, onR);
      },
      catch(onR) {
        return builder._exec(false).catch(onR);
      },
      maybeSingle() {
        return builder._exec(true);
      },
      single() {
        return builder._exec(true);
      },
    };
    return builder;
  }

  return { from, _pool: pool };
}

module.exports = {
  createPgShim: makeClient,
};
