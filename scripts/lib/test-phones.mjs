// The persona phone for each capture scenario. Dry-run never sends to these.
// Every number here MUST be in GANTRY_TEST_OPERATOR_PHONE so /new works per lane.
export const PERSONA_PHONES = [
  '919900000001', '919900000002', '919900000003', '919900000004',
  '919900000005', '919900000006', '919900000007', '919900000008',
  '919900000009', '919900000010', '919900000011', '919900000012',
];
export const RETURNING_PHONE = '919900000007';
export const RECONCILER_PHONE = '919900000012';
export const OPERATOR_LIST = PERSONA_PHONES.join(',');
