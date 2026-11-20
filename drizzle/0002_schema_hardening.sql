-- Hand-edited after `npm run db:generate -- --name schema_hardening`: v_ledger_line reads transaction/subtransaction
-- deleted_at, whose type changes below, so the view is dropped first and recreated unchanged at the end.
DROP VIEW "v_ledger_line";--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" DROP CONSTRAINT "scheduled_subtransaction_scheduled_id_scheduled_transaction_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_scheduled_id_scheduled_transaction_id_fk";
--> statement-breakpoint
DROP INDEX "payee_name_live";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "last_reconciled_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "category_group" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "login_attempt" ALTER COLUMN "at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "month_note" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "payee" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "expires_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "last_seen_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "subtransaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "target" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "undo_entry" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "undo_entry" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "category_group" ADD COLUMN "deleted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_linked_account_live" ON "category" USING btree ("linked_account_id") WHERE "category"."linked_account_id" IS NOT NULL AND "category"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "category_group_one_per_system_kind" ON "category_group" USING btree ("kind") WHERE "category_group"."kind" <> 'normal';--> statement-breakpoint
CREATE UNIQUE INDEX "payee_one_per_system_kind" ON "payee" USING btree ("system_kind") WHERE "payee"."system_kind" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subtransaction_category_id" ON "subtransaction" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transaction_category_id" ON "transaction" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transaction_payee_id" ON "transaction" USING btree ("payee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payee_name_live" ON "payee" USING btree (lower("name")) WHERE "payee"."deleted_at" IS NULL AND "payee"."transfer_account_id" IS NULL AND "payee"."system_kind" IS NULL;--> statement-breakpoint
-- Recreated exactly as in 0001_ledger_view.sql.
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
WHERE s."deleted_at" IS NULL AND t."deleted_at" IS NULL AND t."is_split";--> statement-breakpoint
-- System payees (spec §4.4) are budget-independent rows, so the migration creates them for both existing and fresh
-- databases. ON CONFLICT keeps it idempotent against payee_one_per_system_kind.
INSERT INTO "payee" ("name", "system_kind") VALUES
  ('Starting Balance', 'starting_balance'),
  ('Reconciliation Balance Adjustment', 'reconciliation_adjustment'),
  ('FX revaluation', 'fx_revaluation')
ON CONFLICT ("system_kind") WHERE "system_kind" IS NOT NULL DO NOTHING;
