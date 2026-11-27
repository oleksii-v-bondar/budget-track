ALTER TABLE "transaction" ADD COLUMN "roundup_of" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_roundup_of_transaction_id_fk" FOREIGN KEY ("roundup_of") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_roundup_of" ON "transaction" USING btree ("roundup_of");