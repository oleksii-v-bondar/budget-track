-- Spec §4.6: one row per budget-relevant line. Non-split transactions are lines themselves; split parents are
-- replaced by their subtransactions, which inherit the parent's account and date. Soft-deleted rows are excluded.
CREATE VIEW "v_ledger_line" AS
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date AS "month",
  t."category_id",
  t."amount",
  t."amount_base",
  t."transfer_account_id" IS NOT NULL AS "is_transfer",
  ca."account_class" AS "counter_account_class",
  t."is_starting_balance",
  t."id" AS "txn_id",
  NULL::uuid AS "subtxn_id"
FROM "transaction" t
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = t."transfer_account_id"
WHERE t."deleted_at" IS NULL AND NOT t."is_split"
UNION ALL
SELECT
  t."account_id",
  a."account_class",
  t."date",
  date_trunc('month', t."date")::date,
  s."category_id",
  s."amount",
  s."amount_base",
  s."transfer_account_id" IS NOT NULL,
  ca."account_class",
  false,
  t."id",
  s."id"
FROM "subtransaction" s
JOIN "transaction" t ON t."id" = s."txn_id"
JOIN "account" a ON a."id" = t."account_id"
LEFT JOIN "account" ca ON ca."id" = s."transfer_account_id"
WHERE s."deleted_at" IS NULL AND t."deleted_at" IS NULL AND t."is_split";
