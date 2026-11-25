CREATE TABLE "bank_import" (
	"import_id" text PRIMARY KEY NOT NULL,
	"transaction_id" uuid,
	"auto_category_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_import" ADD CONSTRAINT "bank_import_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_import_transaction_id" ON "bank_import" USING btree ("transaction_id");--> statement-breakpoint
-- Every import so far, keyed by its account and the bank's reference (its import id after "<uid>:"). Unapproved rows
-- are taken to still have the category their payee gave them.
INSERT INTO "bank_import" ("import_id", "transaction_id", "auto_category_id", "created_at")
SELECT t."account_id"::text || ':' || substr(t."import_id", strpos(t."import_id", ':') + 1), t."id", t."category_id", t."created_at"
FROM "transaction" t
WHERE t."import_id" IS NOT NULL
ON CONFLICT DO NOTHING;
