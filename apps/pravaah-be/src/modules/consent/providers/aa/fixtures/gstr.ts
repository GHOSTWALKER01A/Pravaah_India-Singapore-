/**
 * Dummy GSTR (GST returns) FI payload. Shaped like an AA `GSTR` FI schema
 * summary — annual turnover + per-month filing record. Feeds M2's business
 * cash-flow signal alongside the DEPOSIT statement.
 */
export const dummyGstr = {
  gstin: '29ABCDE1234F1Z5',
  legalName: 'ACME TRADING CO',
  summary: {
    annualTurnover: 4820000,
    filedMonths: 12,
    totalMonths: 12,
    lateFilings: 1,
    financialYear: '2025-26',
  },
  returns: [
    { period: '2025-07', filed: true, filedOn: '2025-08-11', taxableValue: 402000 },
    { period: '2025-08', filed: true, filedOn: '2025-09-10', taxableValue: 388500 },
    { period: '2025-09', filed: true, filedOn: '2025-10-12', taxableValue: 415000 },
    { period: '2025-10', filed: true, filedOn: '2025-11-09', taxableValue: 431200 },
    { period: '2025-11', filed: true, filedOn: '2025-12-14', taxableValue: 398000 },
    { period: '2025-12', filed: true, filedOn: '2026-01-11', taxableValue: 452300 },
    { period: '2026-01', filed: true, filedOn: '2026-02-10', taxableValue: 410000 },
    { period: '2026-02', filed: true, filedOn: '2026-03-12', taxableValue: 389900 },
    { period: '2026-03', filed: true, filedOn: '2026-04-13', taxableValue: 470500 },
    { period: '2026-04', filed: true, filedOn: '2026-05-10', taxableValue: 401800 },
    { period: '2026-05', filed: true, filedOn: '2026-06-11', taxableValue: 428700 },
    { period: '2026-06', filed: true, filedOn: '2026-07-15', taxableValue: 432100 },
  ],
}
