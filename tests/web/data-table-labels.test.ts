import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { Col } from '../../web/lib/ui.js';

// React lives in web/node_modules only; resolve it from there.
const req = createRequire(new URL('../../web/package.json', import.meta.url));
const React = req('react') as typeof import('react');
const { renderToStaticMarkup } = req('react-dom/server') as typeof import('react-dom/server');
// vitest compiles the .tsx with the classic JSX transform, which reads a global React.
(globalThis as { React?: unknown }).React = React;
const { DataTable } = await import('../../web/lib/ui.js');

type Row = { key: string; name: string; units: number };

/** Below 640px the phone CSS renders each cell as `label · value`; the label comes from data-label. */
describe('DataTable data-label', () => {
  const cols: Col<Row>[] = [
    { label: 'Fund', value: (r) => r.name },
    { label: 'Units', value: (r) => r.units, align: 'right' },
    { label: '', value: () => 'x' },
  ];
  const rows: Row[] = [{ key: 'a', name: 'Parag Parikh Flexi Cap', units: 12 }];

  it('every body cell carries its column label', () => {
    const html = renderToStaticMarkup(React.createElement(DataTable<Row>, { cols, rows, rowTone: () => 'red' }));
    const cells = [...html.matchAll(/<td([^>]*)>/g)].map((m) => m[1]);
    expect(cells).toHaveLength(cols.length);
    cols.forEach((c, i) => expect(cells[i]).toContain(`data-label="${c.label}"`));
    expect(html).toContain('class="tr-red"');
  });
});
