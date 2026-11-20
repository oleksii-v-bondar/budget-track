CREATE TYPE "public"."account_type" AS ENUM('checking', 'savings', 'cash', 'credit_card', 'line_of_credit', 'mortgage', 'auto_loan', 'student_loan', 'personal_loan', 'medical_debt', 'other_debt', 'other_asset', 'other_liability');--> statement-breakpoint
CREATE TYPE "public"."category_group_kind" AS ENUM('normal', 'cc_payments', 'debt_payments', 'internal');--> statement-breakpoint
CREATE TYPE "public"."category_system_kind" AS ENUM('rta', 'uncategorized');--> statement-breakpoint
CREATE TYPE "public"."cleared_status" AS ENUM('uncleared', 'cleared', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."flag_color" AS ENUM('red', 'orange', 'yellow', 'green', 'blue', 'purple');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('once', 'daily', 'weekly', 'every_other_week', 'twice_a_month', 'every_4_weeks', 'monthly', 'every_other_month', 'every_3_months', 'every_4_months', 'twice_a_year', 'yearly', 'every_other_year');--> statement-breakpoint
CREATE TYPE "public"."payee_system_kind" AS ENUM('starting_balance', 'reconciliation_adjustment', 'fx_revaluation');--> statement-breakpoint
CREATE TYPE "public"."repeat_unit" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."target_cadence" AS ENUM('weekly', 'monthly', 'yearly', 'custom', 'none');--> statement-breakpoint
CREATE TYPE "public"."target_debt_mode" AS ENUM('min_payment', 'fixed', 'payoff_by_date');--> statement-breakpoint
CREATE TYPE "public"."target_kind" AS ENUM('spending', 'balance', 'debt');--> statement-breakpoint
CREATE TYPE "public"."target_mode" AS ENUM('set_aside', 'refill');--> statement-breakpoint
CREATE TYPE "public"."undo_state" AS ENUM('done', 'undone');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"account_class" text GENERATED ALWAYS AS (CASE
  WHEN type IN ('checking', 'savings', 'cash') THEN 'cash'
  WHEN type IN ('credit_card', 'line_of_credit') THEN 'credit'
  ELSE 'tracking'
END) STORED NOT NULL,
	"currency" text DEFAULT 'PLN' NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"note" text,
	"last_reconciled_at" timestamp with time zone,
	"last_reconciled_balance" bigint,
	"interest_rate" numeric(7, 4),
	"min_payment" bigint,
	"escrow_amount" bigint,
	"paired_category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_currency_iso" CHECK ("account"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "account_interest_rate_non_negative" CHECK ("account"."interest_rate" IS NULL OR "account"."interest_rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text NOT NULL,
	"recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_currency" text DEFAULT 'PLN' NOT NULL,
	"budget_start_month" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_budget_start_first_of_month" CHECK (extract(day from "app_user"."budget_start_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "assignment" (
	"category_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "assignment_category_id_month_pk" PRIMARY KEY("category_id","month"),
	CONSTRAINT "assignment_first_of_month" CHECK (extract(day from "assignment"."month") = 1),
	CONSTRAINT "assignment_non_zero" CHECK ("assignment"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"note" text,
	"system_kind" "category_system_kind",
	"linked_account_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"kind" "category_group_kind" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rate" (
	"currency" text NOT NULL,
	"date" date NOT NULL,
	"rate" numeric(14, 6) NOT NULL,
	"source" text DEFAULT 'nbp' NOT NULL,
	"effective_date" date NOT NULL,
	CONSTRAINT "fx_rate_currency_date_pk" PRIMARY KEY("currency","date")
);
--> statement-breakpoint
CREATE TABLE "loan_interest_override" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "loan_interest_override_account_id_month_pk" PRIMARY KEY("account_id","month"),
	CONSTRAINT "loan_interest_override_first_of_month" CHECK (extract(day from "loan_interest_override"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"success" boolean NOT NULL,
	"ip" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "month_note" (
	"month" date PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "month_note_first_of_month" CHECK (extract(day from "month_note"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "payee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"transfer_account_id" uuid,
	"system_kind" "payee_system_kind",
	"last_category_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payee_transfer_account_id_unique" UNIQUE("transfer_account_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_subtransaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"category_id" uuid,
	"payee_id" uuid,
	"memo" text,
	"transfer_account_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"payee_id" uuid,
	"category_id" uuid,
	"memo" text,
	"amount" bigint NOT NULL,
	"fx_rate" numeric(14, 6),
	"fx_rate_manual" boolean DEFAULT false NOT NULL,
	"flag" "flag_color",
	"transfer_account_id" uuid,
	"is_split" boolean DEFAULT false NOT NULL,
	"frequency" "frequency" NOT NULL,
	"anchor_date" date NOT NULL,
	"next_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "subtransaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"txn_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"amount_base" bigint NOT NULL,
	"category_id" uuid,
	"payee_id" uuid,
	"memo" text,
	"transfer_account_id" uuid,
	"transfer_txn_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target" (
	"category_id" uuid PRIMARY KEY NOT NULL,
	"kind" "target_kind" NOT NULL,
	"cadence" "target_cadence" NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"mode" "target_mode",
	"due_weekday" smallint,
	"due_day_of_month" smallint,
	"due_date" date,
	"repeat_unit" "repeat_unit",
	"repeat_every" integer,
	"start_month" date NOT NULL,
	"debt_mode" "target_debt_mode",
	"snoozed_month" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_amount_non_negative" CHECK ("target"."amount" >= 0),
	CONSTRAINT "target_due_weekday_range" CHECK ("target"."due_weekday" IS NULL OR "target"."due_weekday" BETWEEN 0 AND 6),
	CONSTRAINT "target_due_day_range" CHECK ("target"."due_day_of_month" IS NULL OR "target"."due_day_of_month" BETWEEN 1 AND 31),
	CONSTRAINT "target_repeat_every_positive" CHECK ("target"."repeat_every" IS NULL OR "target"."repeat_every" >= 1),
	CONSTRAINT "target_start_month_first_of_month" CHECK (extract(day from "target"."start_month") = 1),
	CONSTRAINT "target_snoozed_month_first_of_month" CHECK ("target"."snoozed_month" IS NULL OR extract(day from "target"."snoozed_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"payee_id" uuid,
	"category_id" uuid,
	"memo" text,
	"amount" bigint NOT NULL,
	"amount_base" bigint NOT NULL,
	"fx_rate" numeric(14, 6),
	"fx_rate_manual" boolean DEFAULT false NOT NULL,
	"cleared" "cleared_status" DEFAULT 'uncleared' NOT NULL,
	"approved" boolean DEFAULT true NOT NULL,
	"flag" "flag_color",
	"transfer_account_id" uuid,
	"transfer_txn_id" uuid,
	"transfer_subtxn_id" uuid,
	"is_split" boolean DEFAULT false NOT NULL,
	"is_starting_balance" boolean DEFAULT false NOT NULL,
	"scheduled_id" uuid,
	"import_id" text,
	"external_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "undo_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"changes" jsonb NOT NULL,
	"state" "undo_state" DEFAULT 'done' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_paired_category_id_category_id_fk" FOREIGN KEY ("paired_category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_group_id_category_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_linked_account_id_account_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_interest_override" ADD CONSTRAINT "loan_interest_override_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee" ADD CONSTRAINT "payee_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee" ADD CONSTRAINT "payee_last_category_id_category_id_fk" FOREIGN KEY ("last_category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subtransaction" ADD CONSTRAINT "scheduled_subtransaction_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ADD CONSTRAINT "scheduled_transaction_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ADD CONSTRAINT "scheduled_transaction_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ADD CONSTRAINT "scheduled_transaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_transaction" ADD CONSTRAINT "scheduled_transaction_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtransaction" ADD CONSTRAINT "subtransaction_txn_id_transaction_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtransaction" ADD CONSTRAINT "subtransaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtransaction" ADD CONSTRAINT "subtransaction_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtransaction" ADD CONSTRAINT "subtransaction_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtransaction" ADD CONSTRAINT "subtransaction_transfer_txn_id_transaction_id_fk" FOREIGN KEY ("transfer_txn_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target" ADD CONSTRAINT "target_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_account_id_account_id_fk" FOREIGN KEY ("transfer_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_txn_id_transaction_id_fk" FOREIGN KEY ("transfer_txn_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_subtxn_id_subtransaction_id_fk" FOREIGN KEY ("transfer_subtxn_id") REFERENCES "public"."subtransaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_scheduled_id_scheduled_transaction_id_fk" FOREIGN KEY ("scheduled_id") REFERENCES "public"."scheduled_transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_singleton" ON "app_user" USING btree ((true));--> statement-breakpoint
CREATE UNIQUE INDEX "category_one_per_system_kind" ON "category" USING btree ("system_kind") WHERE "category"."system_kind" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "category_group_id" ON "category" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "login_attempt_ip_at" ON "login_attempt" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "login_attempt_at" ON "login_attempt" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "payee_name_live" ON "payee" USING btree (lower("name")) WHERE "payee"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subtransaction_txn_id" ON "subtransaction" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "transaction_account_date" ON "transaction" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "transaction_date" ON "transaction" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_import_id" ON "transaction" USING btree ("account_id","import_id") WHERE "transaction"."import_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_external_id" ON "transaction" USING btree ("account_id","external_id") WHERE "transaction"."external_id" IS NOT NULL;