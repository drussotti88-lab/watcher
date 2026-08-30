import postgres from 'postgres';
import { connectionStringFrom, fromPostgres, type PostgresLike } from '../src/db.ts';

const client = postgres(connectionStringFrom(process.env), { prepare: false, max: 1, connect_timeout: 15 });
const db = fromPostgres(client as unknown as PostgresLike);
try {
  const rows = await db.query<any>(
    `SELECT retailer, state, is_pre_order, release_date, signal, order_limit, price,
            left(name, 44) AS name
       FROM discoveries WHERE user_id = 1 AND status = 'new'
       ORDER BY retailer, name LIMIT 14`,
  );
  console.log('\n  RETAILER          STATE  PRE  RELEASE      SIGNAL     PRICE   NAME');
  for (const r of rows) {
    console.log(
      `  ${String(r.retailer || '-').padEnd(16)} ${String(r.state || '-').padEnd(6)} ` +
        `${r.is_pre_order ? 'yes' : ' - '}  ${String(r.release_date || '-').padEnd(12)} ` +
        `${String(r.signal || '-').padEnd(10)} ${String(r.price ?? '-').padStart(7)}  ${r.name}`,
    );
  }
  const missing = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM discoveries WHERE user_id = 1 AND retailer = ''`,
  );
  console.log(`\n  rows still without a retailer: ${missing[0]?.n}`);
} finally {
  await client.end({ timeout: 5 });
}
