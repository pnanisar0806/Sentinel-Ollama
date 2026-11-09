import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadSizingInput } from '../../src/domain/sizing-input.js';
import { resolveTicker } from '../../src/sources/statement-tickers.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('an INDmoney-keyed holding is priced through its NSE ticker', () => {
  it('Zerodha Gold ETF (IND:INDS29570) takes the NSE:GOLDCASE close', async () => {
    const ind = resolveTicker('GOLDCASE')!;
    expect(ind).toBe('IND:INDS29570');
    await db.query(`insert into instruments (id, kind, name, currency) values ($1,'GOLD','Zerodha Gold ETF','INR'), ('NSE:GOLDCASE','GOLD','Gold ETF','INR')`, [ind]);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      select id, $1, 3481, 7818326, 'zerodha', now(), 'manual-seed' from snapshots where source = 'manual-seed'`, [ind]);
    await db.query(`insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
      values ('NSE:GOLDCASE', '2026-11-05', 2246, 'nse-bhavcopy', now())`);
    const q = (await loadSizingInput(db, '2026-11-06')).quotes.get(ind);
    expect(q).toEqual({ pricePaise: 2246n, asOf: '2026-11-05' });
  });
});
