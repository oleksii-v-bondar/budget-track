CREATE TYPE "public"."bank_connection_status" AS ENUM('active', 'reconnect_needed');--> statement-breakpoint
CREATE TABLE "bank_account" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text,
	"provider_name" text,
	"account_id" uuid,
	"last_synced_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_expires_at" timestamp (3) with time zone NOT NULL,
	"status" "bank_connection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;