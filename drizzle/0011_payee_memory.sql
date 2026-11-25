CREATE TABLE "payee_alias" (
	"key" text PRIMARY KEY NOT NULL,
	"payee_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "imported_payee" text;--> statement-breakpoint
ALTER TABLE "payee_alias" ADD CONSTRAINT "payee_alias_payee_id_payee_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Imports before this kept the bank's text only as their payee's name.
UPDATE "transaction" t SET "imported_payee" = p."name" FROM "payee" p WHERE p."id" = t."payee_id" AND t."import_id" IS NOT NULL;
