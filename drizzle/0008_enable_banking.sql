-- Replaces the Aiia bank tables (no real data yet) with the Enable Banking ones.
DROP TABLE "bank_account" CASCADE;--> statement-breakpoint
DROP TABLE "bank_connection" CASCADE;--> statement-breakpoint
CREATE TABLE "bank_account" (
	"uid" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"iban" text,
	"currency" text NOT NULL,
	"account_id" uuid,
	"last_synced_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"aspsp_name" text NOT NULL,
	"aspsp_country" text NOT NULL,
	"valid_until" timestamp (3) with time zone NOT NULL,
	"status" "bank_connection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_connection_aspsp" ON "bank_connection" USING btree ("aspsp_name","aspsp_country");