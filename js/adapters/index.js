// adapters/index.js — the source adapter registry.
//
// Only one adapter exists today. The boundary is here anyway, because
// retrofitting it means unpicking the parse step from every consumer.
//
// Adapter 2 (MYOB Acumatica OData via a Firebase Cloud Function) is documented
// in DATA_SOURCE_ARCHITECTURE.md §5 and deliberately NOT built: the blockers
// are organisational — API licence, tenant admin, and confirming the export is
// a Generic Inquiry rather than a screen grid. When it lands it registers here
// and nothing downstream changes.
//
// The contract, in full:
//   fetch(opts) -> { rows, sourceId, sourceLabel, retrievedAt, warnings }
//
// RawRow keys are the ERP column names EXACTLY as they appear — 'Production
// Nbr.' with the trailing dot, 'Qty. to Produce' with its spaces. Do not
// normalise to camelCase here. An OData feed on a Generic Inquiry returns the
// same column captions the Excel export uses, so preserving them means the
// transform needs zero changes when the second adapter arrives. Normalising is
// the transform's job, downstream, done once.

import { xlsxAdapter } from './xlsx.js';
export { validateColumns, normaliseRefs } from './xlsx.js';

export const ADAPTERS = {
  [xlsxAdapter.id]: xlsxAdapter,
};

export function getAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Unknown source adapter '${id}'`);
  return a;
}

export { xlsxAdapter };
